/**
 * Context Module
 *
 * Provides type-safe context layer for PII/Non-PII database separation.
 *
 * Usage in Hono handlers (recommended):
 * ```typescript
 * import { createAuthContextFromHono, createPIIContextFromHono } from '@authrim/ar-lib-core';
 *
 * app.get('/authorize', async (c) => {
 *   // Requires requestContextMiddleware, or pass an explicit tenant ID.
 *   const ctx = createAuthContextFromHono(c);
 *   const session = await ctx.repositories.session.findById(sessionId);
 * });
 *
 * app.get('/userinfo', async (c) => {
 *   // Requires requestContextMiddleware, or pass an explicit tenant ID.
 *   const ctx = createPIIContextFromHono(c);
 *   // Runtime users are materialized through CanonicalRuntimeUserStore.
 * });
 * ```
 *
 * Usage with factory (advanced):
 * ```typescript
 * const factory = createContextFactory(coreAdapter, tenantId, piiAdapter, partitionRouter);
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
  getRuntimeUserStoreSourcesFromHonoContext,
  hasPIIDatabase,
  resolveOptionalCoreAdapterFromHono,
} from './hono-context';
