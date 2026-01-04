/**
 * Event Hook Registry
 *
 * Manages registration and lookup of Before and After hooks.
 * - Before Hooks: Validation/denial/annotation only (NO side effects)
 * - After Hooks: Side effects allowed (audit, webhook, cleanup)
 *
 * Design decisions:
 * - Separate storage for Before and After hooks
 * - Pattern matching using matchEventPattern() from unified-event.ts
 * - Priority-based ordering (higher priority executes first)
 * - Before Hook timeout = deny (security-first approach)
 *
 * @packageDocumentation
 */

import type {
  EventHookRegistry as IEventHookRegistry,
  BeforeHookConfig,
  AfterHookConfig,
  BeforeHooksResult,
  BeforeHookExecutionResult,
  BeforeHookResult,
} from '../types/events/hooks';
import type { EventHandlerContext } from '../types/events/handler';
import type { UnifiedEvent } from '../types/events/unified-event';
import { matchEventPattern } from '../types/events/unified-event';
import { createLogger } from '../utils/logger';

const log = createLogger().module('EVENT-HOOK-REGISTRY');

// =============================================================================
// Default Values
// =============================================================================

/** Default Before Hook timeout in milliseconds (short to avoid blocking) */
const DEFAULT_BEFORE_HOOK_TIMEOUT_MS = 5000;

/** Default After Hook timeout in milliseconds */
const DEFAULT_AFTER_HOOK_TIMEOUT_MS = 30000;

/** Default priority */
const DEFAULT_PRIORITY = 0;

// =============================================================================
// Timeout Error
// =============================================================================

/**
 * Error thrown when a hook times out.
 */
export class HookTimeoutError extends Error {
  constructor(hookId: string, timeoutMs: number) {
    super(`Hook '${hookId}' timed out after ${timeoutMs}ms`);
    this.name = 'HookTimeoutError';
  }
}

// =============================================================================
// Timeout Utility
// =============================================================================

/**
 * Create a promise that rejects after the specified timeout.
 */
function createTimeout(ms: number, hookId: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new HookTimeoutError(hookId, ms));
    }, ms);
  });
}

/**
 * Execute a promise with a timeout.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, hookId: string): Promise<T> {
  return Promise.race([promise, createTimeout(timeoutMs, hookId)]);
}

// =============================================================================
// Event Hook Registry Implementation
// =============================================================================

/**
 * Configuration for creating a hook registry.
 */
export interface HookRegistryConfig {
  /** Initial Before Hooks to register */
  beforeHooks?: BeforeHookConfig[];
  /** Initial After Hooks to register */
  afterHooks?: AfterHookConfig[];
}

/**
 * Event Hook Registry implementation.
 *
 * Manages Before and After hooks for event processing.
 * Before Hooks can validate/deny/annotate events.
 * After Hooks can perform side effects.
 *
 * @example
 * ```typescript
 * const registry = createEventHookRegistry();
 *
 * // Register a Before Hook (validation only)
 * registry.registerBefore({
 *   id: 'rate-limiter',
 *   name: 'Rate Limiter',
 *   eventPattern: 'auth.*',
 *   handler: async (event, ctx) => {
 *     if (await isRateLimited(event.metadata.ipAddress)) {
 *       return { continue: false, denyReason: 'Rate limited' };
 *     }
 *     return { continue: true };
 *   },
 * });
 *
 * // Register an After Hook (side effects allowed)
 * registry.registerAfter({
 *   id: 'audit-logger',
 *   name: 'Audit Logger',
 *   eventPattern: '*',
 *   handler: async (event, result, ctx) => {
 *     await writeAuditLog(event);
 *   },
 * });
 * ```
 */
export class EventHookRegistryImpl implements IEventHookRegistry {
  /** Before Hook storage by ID */
  private beforeHooks: Map<string, BeforeHookConfig> = new Map();

  /** After Hook storage by ID */
  private afterHooks: Map<string, AfterHookConfig> = new Map();

  /**
   * Create a new event hook registry.
   *
   * @param config - Optional initial configuration
   */
  constructor(config?: HookRegistryConfig) {
    if (config?.beforeHooks) {
      for (const hook of config.beforeHooks) {
        this.registerBefore(hook);
      }
    }
    if (config?.afterHooks) {
      for (const hook of config.afterHooks) {
        this.registerAfter(hook);
      }
    }
  }

  // ===========================================================================
  // Before Hook Methods
  // ===========================================================================

  /**
   * Register a Before Hook.
   *
   * @param config - Hook configuration
   * @returns Hook ID
   * @throws Error if hook ID is empty or eventPattern is empty
   */
  registerBefore(config: BeforeHookConfig): string {
    this.validateHookConfig(config, 'Before');

    const normalizedConfig: BeforeHookConfig = {
      ...config,
      priority: config.priority ?? DEFAULT_PRIORITY,
      enabled: config.enabled ?? true,
      timeoutMs: config.timeoutMs ?? DEFAULT_BEFORE_HOOK_TIMEOUT_MS,
    };

    this.beforeHooks.set(config.id, normalizedConfig);
    return config.id;
  }

  /**
   * Get Before Hooks matching an event type.
   *
   * Returns hooks sorted by priority (highest first).
   * Only enabled hooks are returned.
   *
   * @param eventType - Event type to match
   * @returns Matching Before Hook configs
   */
  getBeforeHooks(eventType: string): BeforeHookConfig[] {
    return this.getMatchingHooks(this.beforeHooks, eventType);
  }

  /**
   * Get all registered Before Hooks.
   *
   * @returns All Before Hook configs
   */
  getAllBeforeHooks(): BeforeHookConfig[] {
    return Array.from(this.beforeHooks.values());
  }

  // ===========================================================================
  // After Hook Methods
  // ===========================================================================

  /**
   * Register an After Hook.
   *
   * @param config - Hook configuration
   * @returns Hook ID
   * @throws Error if hook ID is empty or eventPattern is empty
   */
  registerAfter(config: AfterHookConfig): string {
    this.validateHookConfig(config, 'After');

    const normalizedConfig: AfterHookConfig = {
      ...config,
      priority: config.priority ?? DEFAULT_PRIORITY,
      enabled: config.enabled ?? true,
      timeoutMs: config.timeoutMs ?? DEFAULT_AFTER_HOOK_TIMEOUT_MS,
      async: config.async ?? false,
      continueOnError: config.continueOnError ?? true,
    };

    this.afterHooks.set(config.id, normalizedConfig);
    return config.id;
  }

  /**
   * Get After Hooks matching an event type.
   *
   * Returns hooks sorted by priority (highest first).
   * Only enabled hooks are returned.
   *
   * @param eventType - Event type to match
   * @returns Matching After Hook configs
   */
  getAfterHooks(eventType: string): AfterHookConfig[] {
    return this.getMatchingHooks(this.afterHooks, eventType);
  }

  /**
   * Get all registered After Hooks.
   *
   * @returns All After Hook configs
   */
  getAllAfterHooks(): AfterHookConfig[] {
    return Array.from(this.afterHooks.values());
  }

  // ===========================================================================
  // Common Methods
  // ===========================================================================

  /**
   * Unregister a hook (Before or After).
   *
   * @param id - Hook ID
   */
  unregister(id: string): void {
    this.beforeHooks.delete(id);
    this.afterHooks.delete(id);
  }

  /**
   * Enable or disable a hook.
   *
   * @param id - Hook ID
   * @param enabled - Whether to enable
   * @throws Error if hook not found
   */
  setEnabled(id: string, enabled: boolean): void {
    const beforeHook = this.beforeHooks.get(id);
    if (beforeHook) {
      beforeHook.enabled = enabled;
      return;
    }

    const afterHook = this.afterHooks.get(id);
    if (afterHook) {
      afterHook.enabled = enabled;
      return;
    }

    throw new Error(`Hook not found: ${id}`);
  }

  /**
   * Check if a hook exists.
   *
   * @param id - Hook ID
   * @returns Whether the hook exists
   */
  hasHook(id: string): boolean {
    return this.beforeHooks.has(id) || this.afterHooks.has(id);
  }

  /**
   * Get a hook by ID (Before or After).
   *
   * @param id - Hook ID
   * @returns Hook config or undefined
   */
  getHook(id: string): BeforeHookConfig | AfterHookConfig | undefined {
    return this.beforeHooks.get(id) ?? this.afterHooks.get(id);
  }

  /**
   * Clear all hooks.
   */
  clear(): void {
    this.beforeHooks.clear();
    this.afterHooks.clear();
  }

  /**
   * Get the total count of registered hooks.
   */
  get size(): number {
    return this.beforeHooks.size + this.afterHooks.size;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Validate hook configuration.
   */
  private validateHookConfig(
    config: BeforeHookConfig | AfterHookConfig,
    type: 'Before' | 'After'
  ): void {
    if (!config.id || config.id.trim() === '') {
      throw new Error(`${type} Hook ID is required`);
    }
    if (!config.eventPattern || config.eventPattern.trim() === '') {
      throw new Error(`${type} Hook event pattern is required`);
    }
    if (typeof config.handler !== 'function') {
      throw new Error(`${type} Hook handler function is required`);
    }
  }

  /**
   * Get matching hooks from a map, sorted by priority.
   */
  private getMatchingHooks<
    T extends { eventPattern: string; enabled?: boolean; priority?: number },
  >(hooks: Map<string, T>, eventType: string): T[] {
    const matching: T[] = [];

    for (const hook of hooks.values()) {
      if (!hook.enabled) {
        continue;
      }
      if (matchEventPattern(eventType, hook.eventPattern)) {
        matching.push(hook);
      }
    }

    return matching.sort((a, b) => {
      const priorityA = a.priority ?? DEFAULT_PRIORITY;
      const priorityB = b.priority ?? DEFAULT_PRIORITY;
      return priorityB - priorityA;
    });
  }
}

// =============================================================================
// Before Hook Executor
// =============================================================================

/**
 * Execute all Before Hooks for an event.
 *
 * Hooks are executed in priority order. If any hook returns `continue: false`,
 * execution stops and the event is denied.
 *
 * **Timeout behavior**: If a hook times out, it is treated as a DENY.
 * This is a security-first approach: no response = not permitted.
 *
 * @param hooks - Before Hook configs to execute
 * @param event - Event being processed
 * @param context - Handler context
 * @returns Combined result of all hook executions
 *
 * @example
 * ```typescript
 * const result = await executeBeforeHooks(
 *   registry.getBeforeHooks('auth.login.succeeded'),
 *   event,
 *   context
 * );
 *
 * if (!result.continue) {
 *   throw new Error(`Event denied: ${result.denyReason}`);
 * }
 * ```
 */
export async function executeBeforeHooks(
  hooks: BeforeHookConfig[],
  event: UnifiedEvent,
  context: EventHandlerContext
): Promise<BeforeHooksResult> {
  const hookResults: BeforeHookExecutionResult[] = [];
  const mergedAnnotations: Record<string, unknown> = {};

  for (const hook of hooks) {
    const startTime = Date.now();

    try {
      // Execute hook with timeout
      const result = await withTimeout(
        hook.handler(event, context),
        hook.timeoutMs ?? DEFAULT_BEFORE_HOOK_TIMEOUT_MS,
        hook.id
      );

      const durationMs = Date.now() - startTime;

      hookResults.push({
        hookId: hook.id,
        hookName: hook.name,
        success: true,
        durationMs,
        result,
      });

      // Merge annotations
      if (result.annotations) {
        Object.assign(mergedAnnotations, result.annotations);
      }

      // If hook denies, stop execution
      if (!result.continue) {
        return {
          continue: false,
          annotations: mergedAnnotations,
          denyReason: result.denyReason,
          denyCode: result.denyCode,
          hookResults,
        };
      }
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const isTimeout = error instanceof HookTimeoutError;

      hookResults.push({
        hookId: hook.id,
        hookName: hook.name,
        success: false,
        durationMs,
        error: error instanceof Error ? error.message : String(error),
      });

      // Timeout = DENY (security-first approach)
      // Hook not responding = cannot permit the action
      if (isTimeout) {
        return {
          continue: false,
          annotations: mergedAnnotations,
          denyReason: 'Hook timeout',
          denyCode: 'HOOK_TIMEOUT',
          hookResults,
        };
      }

      // Other errors: log and continue (or rethrow based on config)
      // For now, we treat other errors as non-blocking
      log.error('Before hook failed', { hookId: hook.id, hookName: hook.name }, error as Error);
    }
  }

  // All hooks passed
  return {
    continue: true,
    annotations: mergedAnnotations,
    hookResults,
  };
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new event hook registry.
 *
 * @param config - Optional initial configuration
 * @returns Event hook registry instance
 *
 * @example
 * ```typescript
 * // Create empty registry
 * const registry = createEventHookRegistry();
 *
 * // Create registry with initial hooks
 * const registry = createEventHookRegistry({
 *   beforeHooks: [
 *     {
 *       id: 'validator',
 *       name: 'Validator',
 *       eventPattern: '*',
 *       handler: async (event) => ({ continue: true }),
 *     },
 *   ],
 *   afterHooks: [
 *     {
 *       id: 'logger',
 *       name: 'Logger',
 *       eventPattern: '*',
 *       handler: async (event, result, ctx) => { console.log(event); },
 *     },
 *   ],
 * });
 * ```
 */
export function createEventHookRegistry(config?: HookRegistryConfig): EventHookRegistryImpl {
  return new EventHookRegistryImpl(config);
}
