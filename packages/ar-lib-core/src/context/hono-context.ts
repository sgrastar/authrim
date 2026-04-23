/**
 * Hono Context Integration
 *
 * Helper functions to create AuthContext and PIIContext from Hono Context.
 * Simplifies repository access in Hono route handlers.
 *
 * Usage:
 * ```typescript
 * import { createAuthContextFromHono, createPIIContextFromHono } from '@authrim/ar-lib-core';
 *
 * app.get('/authorize', async (c) => {
 *   const ctx = createAuthContextFromHono(c);
 *   const session = await ctx.repositories.session.findById(sessionId);
 *   // ...
 * });
 *
 * app.get('/userinfo', async (c) => {
 *   const ctx = createPIIContextFromHono(c);
 *   const userPII = await ctx.piiRepositories.userPII.findByUserId(userId);
 *   // ...
 * });
 * ```
 */

import type { Context as HonoContext } from 'hono';
import type { Env } from '../types/env';
import type { AuthContext, PIIContext } from './types';
import { ensureDatabaseAdapter } from '../db/adapter-source';
import { PIIPartitionRouter } from '../db/partition-router';
import {
  UserCoreRepository,
  ClientRepository,
  SessionRepository,
  PasskeyRepository,
  RoleRepository,
  SessionClientRepository,
} from '../repositories/core';
import {
  UserPIIRepository,
  TombstoneRepository,
  SubjectIdentifierRepository,
  LinkedIdentityRepository,
  PIIAuditLogRepository,
} from '../repositories/pii';
import { MapRequestScopedCache } from './types';
import type { ResolvedUserStoreRuntimeSources } from '../services/user-store-runtime-sources';

function getTenantIdFromHonoContext(c: HonoContext<{ Bindings: Env }>): string | undefined {
  // Hono's generic context type does not know about middleware-injected values.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((c as any).get?.('tenantId') as string | undefined) || undefined;
}

function getRuntimeUserStoreSourcesFromHonoContext(
  c: HonoContext<{ Bindings: Env }>
): ResolvedUserStoreRuntimeSources | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((c as any).get?.('runtimeUserStoreSources') as ResolvedUserStoreRuntimeSources | undefined)
    || undefined;
}

/**
 * Create AuthContext from Hono Context
 *
 * Use this for handlers that only need non-PII data:
 * - /authorize
 * - /token
 * - /introspect
 * - /revoke
 *
 * @param c - Hono context
 * @param tenantId - Optional tenant ID (default: 'default')
 * @returns AuthContext with core repositories
 */
export function createAuthContextFromHono(
  c: HonoContext<{ Bindings: Env }>,
  tenantId?: string
): AuthContext {
  const resolvedTenantId = tenantId || getTenantIdFromHonoContext(c) || 'default';
  const runtimeSources = getRuntimeUserStoreSourcesFromHonoContext(c);
  const coreAdapter = ensureDatabaseAdapter(runtimeSources?.coreDb ?? c.env.DB, 'core');

  return {
    tenantId: resolvedTenantId,
    repositories: {
      userCore: new UserCoreRepository(coreAdapter),
      client: new ClientRepository(coreAdapter),
      session: new SessionRepository(coreAdapter),
      passkey: new PasskeyRepository(coreAdapter),
      role: new RoleRepository(coreAdapter),
      sessionClient: new SessionClientRepository(coreAdapter),
    },
    coreAdapter,
    cache: new MapRequestScopedCache(),
    honoContext: c,
  };
}

/**
 * Create PIIContext from Hono Context
 *
 * Use this for handlers that need PII data:
 * - /userinfo
 * - /admin/users
 * - User registration
 * - GDPR data export/deletion
 *
 * @param c - Hono context
 * @param tenantId - Optional tenant ID (default: 'default')
 * @returns PIIContext with both core and PII repositories
 * @throws Error if DB_PII is not configured
 */
export function createPIIContextFromHono(
  c: HonoContext<{ Bindings: Env }>,
  tenantId?: string
): PIIContext {
  const resolvedTenantId = tenantId || getTenantIdFromHonoContext(c) || 'default';
  const runtimeSources = getRuntimeUserStoreSourcesFromHonoContext(c);
  const piiSource = runtimeSources?.piiDb ?? c.env.DB_PII ?? c.env.DB;

  if (!piiSource) {
    throw new Error('PII database is not configured. Cannot create PIIContext.');
  }

  const coreAdapter = ensureDatabaseAdapter(runtimeSources?.coreDb ?? c.env.DB, 'core');
  const piiAdapter = ensureDatabaseAdapter(piiSource, 'pii');

  // Create partition router with default PII adapter
  const partitionRouter = new PIIPartitionRouter(coreAdapter, piiAdapter, c.env.AUTHRIM_CONFIG);

  return {
    tenantId: resolvedTenantId,
    repositories: {
      userCore: new UserCoreRepository(coreAdapter),
      client: new ClientRepository(coreAdapter),
      session: new SessionRepository(coreAdapter),
      passkey: new PasskeyRepository(coreAdapter),
      role: new RoleRepository(coreAdapter),
      sessionClient: new SessionClientRepository(coreAdapter),
    },
    coreAdapter,
    cache: new MapRequestScopedCache(),
    honoContext: c,
    piiRepositories: {
      userPII: new UserPIIRepository(piiAdapter),
      tombstone: new TombstoneRepository(piiAdapter),
      identifier: new SubjectIdentifierRepository(piiAdapter),
      linkedIdentity: new LinkedIdentityRepository(piiAdapter),
      auditLog: new PIIAuditLogRepository(piiAdapter),
    },
    partitionRouter,
    defaultPiiAdapter: piiAdapter,
    getPiiAdapter: (partition) => partitionRouter.getAdapterForPartition(partition),
  };
}

/**
 * Create PIIContext from existing AuthContext
 *
 * Use this when a handler needs to access PII conditionally.
 * Reuses the existing core repositories and cache.
 *
 * @param authCtx - Existing AuthContext
 * @returns PIIContext with PII repositories added
 * @throws Error if DB_PII is not configured
 */
export function elevateToPIIContext(authCtx: AuthContext): PIIContext {
  const c = authCtx.honoContext as HonoContext<{ Bindings: Env }>;
  const runtimeSources = getRuntimeUserStoreSourcesFromHonoContext(c);
  const piiSource = runtimeSources?.piiDb ?? c.env.DB_PII ?? c.env.DB;
  if (!piiSource) {
    throw new Error('PII database is not configured. Cannot elevate to PIIContext.');
  }

  const piiAdapter = ensureDatabaseAdapter(piiSource, 'pii');
  const partitionRouter = new PIIPartitionRouter(
    authCtx.coreAdapter,
    piiAdapter,
    c.env.AUTHRIM_CONFIG
  );

  return {
    ...authCtx,
    piiRepositories: {
      userPII: new UserPIIRepository(piiAdapter),
      tombstone: new TombstoneRepository(piiAdapter),
      identifier: new SubjectIdentifierRepository(piiAdapter),
      linkedIdentity: new LinkedIdentityRepository(piiAdapter),
      auditLog: new PIIAuditLogRepository(piiAdapter),
    },
    partitionRouter,
    defaultPiiAdapter: piiAdapter,
    getPiiAdapter: (partition) => partitionRouter.getAdapterForPartition(partition),
  };
}

/**
 * Type guard to check if DB_PII is available
 *
 * @param c - Hono context
 * @returns True if DB_PII is configured
 */
export function hasPIIDatabase(c: HonoContext<{ Bindings: Env }>): boolean {
  return !!(getRuntimeUserStoreSourcesFromHonoContext(c)?.piiDb ?? c.env.DB_PII ?? c.env.DB);
}
