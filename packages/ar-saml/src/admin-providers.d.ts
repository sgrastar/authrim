import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

/** Provider handlers without importing internal XML and runtime types into consumers. */
export declare function handleCreateProvider(c: Context<{ Bindings: Env }>): Promise<Response>;
export declare function handleUpdateProvider(c: Context<{ Bindings: Env }>): Promise<Response>;
