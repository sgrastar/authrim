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
 *   // Requires requestContextMiddleware, or pass an explicit tenant ID.
 *   const ctx = createAuthContextFromHono(c);
 *   const client = await ctx.repositories.client.findByClientId(clientId);
 *   // Session state is accessed through SessionStore Durable Objects.
 * });
 *
 * app.get('/userinfo', async (c) => {
 *   // Requires requestContextMiddleware, or pass an explicit tenant ID.
 *   const ctx = createPIIContextFromHono(c);
 *   // Runtime users are materialized through CanonicalRuntimeUserStore.
 * });
 * ```
 */

import type { Context as HonoContext } from 'hono';
import type { Env } from '../types/env';
import type { AuthContext, PIIContext } from './types';
import type { DatabaseAdapter } from '../db/adapter';
import { ensureDatabaseAdapter, ensureOptionalDatabaseAdapter } from '../db/adapter-source';
import { PIIPartitionRouter } from '../db/partition-router';
import {
  ClientRepository,
  PasskeyRepository,
  TotpCredentialRepository,
  RoleRepository,
  SessionClientRepository,
} from '../repositories/core';
import {
  TombstoneRepository,
  SubjectIdentifierRepository,
  LinkedIdentityRepository,
  PIIAuditLogRepository,
} from '../repositories/pii';
import { MapRequestScopedCache } from './types';
import {
  getAccountDataContextFromHono,
  getTenantMetadataContextFromHono,
} from '../services/runtime-data-context';

function getTenantIdFromHonoContext(c: HonoContext<{ Bindings: Env }>): string | undefined {
  // Hono's generic context type does not know about middleware-injected values.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((c as any).get?.('tenantId') as string | undefined)?.trim() || undefined;
}

function resolveRequiredTenantId(
  c: HonoContext<{ Bindings: Env }>,
  tenantId: string | undefined,
  operation: string
): string {
  const resolvedTenantId = tenantId?.trim() || getTenantIdFromHonoContext(c);
  if (!resolvedTenantId) {
    throw new Error(`${operation} requires tenant context`);
  }
  return resolvedTenantId;
}

/**
 * Resolve the core adapter from runtime user-store sources or env bindings, if available.
 *
 * Use this in routes where DB-backed bookkeeping is optional and should not force a
 * hard dependency on `env.DB`.
 */
export function resolveOptionalCoreAdapterFromHono(
  c: HonoContext<{ Bindings: Env }>,
  partition: string = 'core'
): DatabaseAdapter | null {
  const tenantMetadata = getTenantMetadataContextFromHono(c);
  return ensureOptionalDatabaseAdapter(tenantMetadata?.coreDb ?? null, partition);
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
 * @param tenantId - Optional explicit tenant ID. If omitted, request context tenant is required.
 * @returns AuthContext with core repositories
 */
export function createAuthContextFromHono(
  c: HonoContext<{ Bindings: Env }>,
  tenantId?: string
): AuthContext {
  const resolvedTenantId = resolveRequiredTenantId(c, tenantId, 'createAuthContextFromHono');
  const tenantMetadata = getTenantMetadataContextFromHono(c);
  if (!tenantMetadata) throw new Error('tenant_metadata_context_required');
  if (tenantMetadata.tenantId !== resolvedTenantId) {
    throw new Error('tenant_metadata_context_conflict');
  }
  const coreAdapter = ensureDatabaseAdapter(tenantMetadata.coreDb, 'core');

  return {
    tenantId: resolvedTenantId,
    repositories: {
      client: new ClientRepository(coreAdapter, resolvedTenantId),
      passkey: new PasskeyRepository(coreAdapter, resolvedTenantId),
      totp: new TotpCredentialRepository(coreAdapter, resolvedTenantId),
      role: new RoleRepository(coreAdapter, resolvedTenantId),
      sessionClient: new SessionClientRepository(coreAdapter, resolvedTenantId),
    },
    coreAdapter,
    cache: new MapRequestScopedCache(),
    honoContext: c,
  };
}

/**
 * Create an AuthContext for account-scoped core data.
 * Callers must resolve and attach AccountDataContext before account-scoped access.
 */
export function createAccountAuthContextFromHono(
  c: HonoContext<{ Bindings: Env }>,
  tenantId?: string
): AuthContext {
  const resolvedTenantId = resolveRequiredTenantId(c, tenantId, 'createAccountAuthContextFromHono');
  const accountData = getAccountDataContextFromHono(c);
  if (accountData && accountData.tenantId !== resolvedTenantId) {
    throw new Error('account_data_context_conflict');
  }
  if (!accountData) throw new Error('account_data_context_required');

  const coreAdapter = ensureDatabaseAdapter(accountData.coreDb, 'account-core');
  return {
    tenantId: resolvedTenantId,
    repositories: {
      client: new ClientRepository(coreAdapter, resolvedTenantId),
      passkey: new PasskeyRepository(coreAdapter, resolvedTenantId),
      totp: new TotpCredentialRepository(coreAdapter, resolvedTenantId),
      role: new RoleRepository(coreAdapter, resolvedTenantId),
      sessionClient: new SessionClientRepository(coreAdapter, resolvedTenantId),
    },
    coreAdapter,
    cache: new MapRequestScopedCache(),
    honoContext: c,
    userCacheScope: accountData.userCacheScope,
    piiCacheMode: accountData.piiCacheMode,
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
 * @param tenantId - Optional explicit tenant ID. If omitted, request context tenant is required.
 * @returns PIIContext with both core and PII repositories
 * @throws Error if DB_PII is not configured
 */
export function createPIIContextFromHono(
  c: HonoContext<{ Bindings: Env }>,
  tenantId?: string
): PIIContext {
  const resolvedTenantId = resolveRequiredTenantId(c, tenantId, 'createPIIContextFromHono');
  const accountData = getAccountDataContextFromHono(c);
  if (accountData && accountData.tenantId !== resolvedTenantId) {
    throw new Error('account_data_context_conflict');
  }
  if (!accountData) throw new Error('account_data_context_required');

  const coreAdapter = ensureDatabaseAdapter(accountData.coreDb, 'core');
  const piiAdapter = ensureDatabaseAdapter(accountData.piiDb, 'pii');

  // Create partition router with default PII adapter
  const partitionRouter = new PIIPartitionRouter(coreAdapter, piiAdapter, c.env.AUTHRIM_CONFIG);

  return {
    tenantId: resolvedTenantId,
    repositories: {
      client: new ClientRepository(coreAdapter, resolvedTenantId),
      passkey: new PasskeyRepository(coreAdapter, resolvedTenantId),
      totp: new TotpCredentialRepository(coreAdapter, resolvedTenantId),
      role: new RoleRepository(coreAdapter, resolvedTenantId),
      sessionClient: new SessionClientRepository(coreAdapter, resolvedTenantId),
    },
    coreAdapter,
    cache: new MapRequestScopedCache(),
    honoContext: c,
    userCacheScope: accountData.userCacheScope,
    piiCacheMode: accountData.piiCacheMode,
    piiRepositories: {
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
  const accountData = getAccountDataContextFromHono(c);
  if (accountData && accountData.tenantId !== authCtx.tenantId) {
    throw new Error('account_data_context_conflict');
  }
  if (!accountData) throw new Error('account_data_context_required');
  return createPIIContextFromHono(c, authCtx.tenantId);
}

/**
 * Type guard to check if DB_PII is available
 *
 * @param c - Hono context
 * @returns True if DB_PII is configured
 */
export function hasPIIDatabase(c: HonoContext<{ Bindings: Env }>): boolean {
  const accountData = getAccountDataContextFromHono(c);
  return !!accountData?.piiDb;
}
