/**
 * Actor abstraction layer for Durable Objects
 *
 * This module provides platform-agnostic interfaces for stateful actors,
 * enabling future portability to other platforms (AWS, Azure, etc.)
 * while maintaining Cloudflare Durable Objects as the primary implementation.
 *
 * @example
 * ```typescript
 * import { ActorContext, ActorStorage } from '@authrim/shared/actor';
 * import { CloudflareActorContext } from '@authrim/shared/actor/adapters/cloudflare-actor-adapter';
 *
 * class MyDurableObject extends DurableObject {
 *   private actorCtx: ActorContext;
 *
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env);
 *     this.actorCtx = new CloudflareActorContext(ctx);
 *   }
 * }
 * ```
 */

// Core interfaces
export type { ActorContext } from './actor-context';
export type { ActorStorage, StoragePutOptions, StorageListOptions } from './actor-storage';

// Adapters
export { CloudflareActorContext } from './adapters/cloudflare-actor-adapter';
