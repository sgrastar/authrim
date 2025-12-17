/**
 * Context Module
 *
 * Provides type-safe context layer for PII/Non-PII database separation.
 *
 * Usage in Hono handlers (recommended):
 * ```typescript
 * import { createAuthContextFromHono, createPIIContextFromHono } from '@authrim/shared';
 *
 * app.get('/authorize', async (c) => {
 *   const ctx = createAuthContextFromHono(c);
 *   const session = await ctx.repositories.session.findById(sessionId);
 * });
 *
 * app.get('/userinfo', async (c) => {
 *   const ctx = createPIIContextFromHono(c);
 *   const userPII = await ctx.piiRepositories.userPII.findByUserId(userId);
 * });
 * ```
 *
 * Usage with factory (advanced):
 * ```typescript
 * const factory = createContextFactory(coreAdapter, piiAdapter, partitionRouter);
 * const ctx = factory.createAuthContext(c);
 * ```
 */

// Types
export type {
  AuthContext,
  PIIContext,
  CoreRepositories,
  PIIRepositories,
  RequestScopedCache,
  AuthHandler,
  PIIHandler,
  ContextFactoryOptions,
  IContextFactory,
} from './types';

// Implementation
export { MapRequestScopedCache } from './types';

// Factory
export { ContextFactory, createContextFactory, isPIIContext, getUserWithPII } from './factory';

// Hono Integration (recommended for route handlers)
export {
  createAuthContextFromHono,
  createPIIContextFromHono,
  elevateToPIIContext,
  hasPIIDatabase,
} from './hono-context';
