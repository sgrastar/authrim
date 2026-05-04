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
export class CloudflareActorContext {
    ctx;
    storage;
    constructor(ctx) {
        this.ctx = ctx;
        this.storage = new CloudflareActorStorage(ctx.storage);
    }
    /**
     * Block concurrent requests during initialization
     * Delegates to Cloudflare's blockConcurrencyWhile
     */
    blockConcurrencyWhile(callback) {
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
class CloudflareActorStorage {
    storage;
    constructor(storage) {
        this.storage = storage;
    }
    async get(key) {
        const value = await this.storage.get(key);
        return value ?? null;
    }
    async put(key, value, _options) {
        // Note: Cloudflare DO storage does not support expirationTtl
        // TTL is managed at the application layer (e.g., expires_at field + cleanup)
        await this.storage.put(key, value);
    }
    async delete(key) {
        return await this.storage.delete(key);
    }
    async deleteMany(keys) {
        return await this.storage.delete(keys);
    }
    async list(options) {
        return await this.storage.list({
            prefix: options?.prefix,
            limit: options?.limit,
        });
    }
}
