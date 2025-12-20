import type { ActorStorage } from './actor-storage';

/**
 * Platform-agnostic Actor Context abstraction
 *
 * Cloudflare: DurableObjectState
 * Future: Custom actor runtime, distributed lock + storage
 *
 * NOTE:
 * ActorContext is intentionally minimal.
 * Do NOT add request, env, alarm, or logging concerns here.
 * Keep it focused on storage and concurrency control only.
 */
export interface ActorContext {
  /**
   * Actor storage instance
   */
  readonly storage: ActorStorage;

  /**
   * Block concurrent requests during initialization or critical sections
   *
   * Cloudflare: blockConcurrencyWhile
   * Future: Distributed lock
   *
   * @param callback - Async function to execute exclusively
   * @returns Promise<T> - The callback's return value (await-able)
   */
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
