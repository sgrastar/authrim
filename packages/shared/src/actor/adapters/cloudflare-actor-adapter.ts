import type { DurableObjectState, DurableObjectStorage } from '@cloudflare/workers-types';
import type { ActorContext } from '../actor-context';
import type { ActorStorage, StoragePutOptions, StorageListOptions } from '../actor-storage';

/**
 * Cloudflare Durable Object implementation of ActorContext
 *
 * Wraps DurableObjectState to provide platform-agnostic storage access.
 *
 * @example
 * ```typescript
 * class SessionStore extends DurableObject {
 *   private actorCtx: ActorContext;
 *
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env);
 *     this.actorCtx = new CloudflareActorContext(ctx);
 *   }
 *
 *   async getSession(id: string) {
 *     return this.actorCtx.storage.get<Session>(`session:${id}`);
 *   }
 * }
 * ```
 */
export class CloudflareActorContext implements ActorContext {
  readonly storage: ActorStorage;

  constructor(private ctx: DurableObjectState) {
    this.storage = new CloudflareActorStorage(ctx.storage);
  }

  /**
   * Block concurrent requests during initialization
   * Delegates to Cloudflare's blockConcurrencyWhile
   */
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return this.ctx.blockConcurrencyWhile(callback);
  }
}

/**
 * Cloudflare Durable Object Storage implementation
 *
 * Note: Cloudflare DO storage does not support TTL natively.
 * TTL management is handled at the application layer with
 * periodic cleanup tasks.
 */
class CloudflareActorStorage implements ActorStorage {
  constructor(private storage: DurableObjectStorage) {}

  async get<T>(key: string): Promise<T | null> {
    const value = await this.storage.get<T>(key);
    return value ?? null;
  }

  async put<T>(key: string, value: T, _options?: StoragePutOptions): Promise<void> {
    // Note: Cloudflare DO storage does not support expirationTtl
    // TTL is managed at the application layer (e.g., expires_at field + cleanup)
    await this.storage.put(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return await this.storage.delete(key);
  }

  async deleteMany(keys: string[]): Promise<number> {
    return await this.storage.delete(keys);
  }

  async list<T>(options?: StorageListOptions): Promise<Map<string, T>> {
    return await this.storage.list<T>({
      prefix: options?.prefix,
      limit: options?.limit,
    });
  }
}
