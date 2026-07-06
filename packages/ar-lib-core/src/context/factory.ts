/**
 * Context Factory
 *
 * Factory for creating AuthContext and PIIContext instances.
 * Provides type-safe access to repositories based on handler requirements.
 *
 * Usage:
 * ```typescript
 * // In your worker entry point
 * const factory = new ContextFactory({
 *   coreAdapter: createD1Adapter(env.DB, 'core'),
 *   tenantId,
 *   defaultPiiAdapter: createD1Adapter(env.DB_PII, 'pii'),
 *   partitionRouter: createPIIPartitionRouter(coreAdapter, piiAdapter, env.AUTHRIM_CONFIG),
 * });
 *
 * // In route handlers
 * app.get('/userinfo', async (c) => {
 *   const ctx = factory.createPIIContext(c);
 *   return handleUserInfo(ctx, c);
 * });
 *
 * app.post('/token', async (c) => {
 *   const ctx = factory.createAuthContext(c);
 *   return handleToken(ctx, c);
 * });
 * ```
 */

import type { Context as HonoContext } from 'hono';
import type { DatabaseAdapter } from '../db/adapter';
import type { PIIPartitionRouter, PartitionKey } from '../db/partition-router';
import {
  ClientRepository,
  SessionRepository,
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
import { CanonicalRuntimeUserStore } from '../repositories/identity';
import {
  type AuthContext,
  type PIIContext,
  type CoreRepositories,
  type PIIRepositories,
  type ContextFactoryOptions,
  type IContextFactory,
  MapRequestScopedCache,
} from './types';

function requireFactoryTenantId(tenantId: string, context: string): string {
  const normalized = tenantId.trim();
  if (!normalized) {
    throw new Error(`${context} requires tenantId`);
  }
  return normalized;
}

// =============================================================================
// Context Factory
// =============================================================================

/**
 * Factory for creating contexts.
 *
 * This factory is typically created once per worker and reused for all requests.
 * Each context is request-scoped (includes request-specific cache).
 */
export class ContextFactory implements IContextFactory {
  private coreAdapter: DatabaseAdapter;
  private defaultPiiAdapter: DatabaseAdapter | null;
  private partitionRouter: PIIPartitionRouter | null;
  private tenantId: string;

  /**
   * Create a new ContextFactory.
   *
   * @param options - Factory options
   */
  constructor(options: ContextFactoryOptions) {
    this.coreAdapter = options.coreAdapter;
    this.defaultPiiAdapter = options.defaultPiiAdapter ?? null;
    this.partitionRouter = options.partitionRouter ?? null;
    this.tenantId = requireFactoryTenantId(options.tenantId, 'ContextFactory');
  }

  /**
   * Create a base AuthContext (Non-PII only).
   *
   * Use this for handlers that don't need personal information.
   *
   * @param c - Hono context
   * @returns AuthContext
   */
  createAuthContext(c: HonoContext): AuthContext {
    const repositories = this.createCoreRepositories();

    return {
      tenantId: this.tenantId,
      repositories,
      coreAdapter: this.coreAdapter,
      cache: new MapRequestScopedCache(),
      honoContext: c,
    };
  }

  /**
   * Create a PIIContext (with PII access).
   *
   * Use this for handlers that need personal information.
   *
   * @param c - Hono context
   * @returns PIIContext
   * @throws Error if PII adapters are not configured
   */
  createPIIContext(c: HonoContext): PIIContext {
    if (!this.defaultPiiAdapter) {
      throw new Error('PII adapter not configured. Cannot create PIIContext.');
    }

    if (!this.partitionRouter) {
      throw new Error('Partition router not configured. Cannot create PIIContext.');
    }

    const repositories = this.createCoreRepositories();
    const piiRepositories = this.createPIIRepositories(this.defaultPiiAdapter);

    return {
      tenantId: this.tenantId,
      repositories,
      coreAdapter: this.coreAdapter,
      cache: new MapRequestScopedCache(),
      honoContext: c,
      piiRepositories,
      partitionRouter: this.partitionRouter,
      defaultPiiAdapter: this.defaultPiiAdapter,
      getPiiAdapter: (partition: PartitionKey) => {
        return this.partitionRouter!.getAdapterForPartition(partition);
      },
    };
  }

  /**
   * Elevate an AuthContext to PIIContext.
   *
   * Use this when a handler starts without PII access
   * but needs to access PII conditionally.
   *
   * @param authCtx - Existing AuthContext
   * @returns PIIContext
   * @throws Error if PII adapters are not configured
   */
  elevateToPIIContext(authCtx: AuthContext): PIIContext {
    if (!this.defaultPiiAdapter) {
      throw new Error('PII adapter not configured. Cannot elevate to PIIContext.');
    }

    if (!this.partitionRouter) {
      throw new Error('Partition router not configured. Cannot elevate to PIIContext.');
    }

    const piiRepositories = this.createPIIRepositories(this.defaultPiiAdapter);

    return {
      ...authCtx,
      piiRepositories,
      partitionRouter: this.partitionRouter,
      defaultPiiAdapter: this.defaultPiiAdapter,
      getPiiAdapter: (partition: PartitionKey) => {
        return this.partitionRouter!.getAdapterForPartition(partition);
      },
    };
  }

  /**
   * Update the tenant ID for subsequent context creation.
   *
   * @param tenantId - New tenant ID
   */
  setTenantId(tenantId: string): void {
    this.tenantId = requireFactoryTenantId(tenantId, 'ContextFactory.setTenantId');
  }

  /**
   * Get the current tenant ID.
   *
   * @returns Current tenant ID
   */
  getTenantId(): string {
    return this.tenantId;
  }

  // ===========================================================================
  // Internal Helpers
  // ===========================================================================

  /**
   * Create core repositories instance.
   */
  private createCoreRepositories(): CoreRepositories {
    return {
      client: new ClientRepository(this.coreAdapter, this.tenantId),
      session: new SessionRepository(this.coreAdapter, this.tenantId),
      passkey: new PasskeyRepository(this.coreAdapter, this.tenantId),
      totp: new TotpCredentialRepository(this.coreAdapter, this.tenantId),
      role: new RoleRepository(this.coreAdapter, this.tenantId),
      sessionClient: new SessionClientRepository(this.coreAdapter, this.tenantId),
      // Future: organization: new OrganizationRepository(this.coreAdapter),
    };
  }

  /**
   * Create PII repositories instance.
   *
   * @param piiAdapter - PII database adapter
   */
  private createPIIRepositories(piiAdapter: DatabaseAdapter): PIIRepositories {
    return {
      tombstone: new TombstoneRepository(piiAdapter),
      identifier: new SubjectIdentifierRepository(piiAdapter),
      linkedIdentity: new LinkedIdentityRepository(piiAdapter),
      auditLog: new PIIAuditLogRepository(piiAdapter),
    };
  }
}

// =============================================================================
// Factory Creation Helper
// =============================================================================

/**
 * Create a ContextFactory with standard configuration.
 *
 * This is a convenience function for creating a factory with common setup.
 *
 * @param coreAdapter - Core database adapter
 * @param tenantId - Tenant ID
 * @param piiAdapter - PII database adapter (optional)
 * @param partitionRouter - Partition router (optional)
 * @returns Configured ContextFactory
 *
 * @example
 * // Minimal setup (Non-PII only)
 * const factory = createContextFactory(createD1Adapter(env.DB, 'core'), tenantId);
 *
 * // Full setup (with PII)
 * const factory = createContextFactory(
 *   createD1Adapter(env.DB, 'core'),
 *   tenantId,
 *   createD1Adapter(env.DB_PII, 'pii'),
 *   createPIIPartitionRouter(coreAdapter, piiAdapter, env.AUTHRIM_CONFIG)
 * );
 */
export function createContextFactory(
  coreAdapter: DatabaseAdapter,
  tenantId: string,
  piiAdapter?: DatabaseAdapter,
  partitionRouter?: PIIPartitionRouter
): ContextFactory {
  return new ContextFactory({
    coreAdapter,
    tenantId,
    defaultPiiAdapter: piiAdapter,
    partitionRouter,
  });
}

// =============================================================================
// Context Utilities
// =============================================================================

/**
 * Type guard to check if a context is a PIIContext.
 *
 * @param ctx - Context to check
 * @returns True if the context is a PIIContext
 */
export function isPIIContext(ctx: AuthContext | PIIContext): ctx is PIIContext {
  return 'piiRepositories' in ctx && 'partitionRouter' in ctx;
}

/**
 * Get user with PII data (cross-database lookup).
 *
 * This is a common pattern for fetching user data from both Core and PII databases.
 *
 * @param ctx - PIIContext
 * @param userId - User ID
 * @returns Combined user data or null
 */
export async function getUserWithPII(
  ctx: PIIContext,
  userId: string
): Promise<Awaited<ReturnType<CanonicalRuntimeUserStore['findById']>>> {
  const piiAdapter = ctx.getPiiAdapter('default');
  const userStore = new CanonicalRuntimeUserStore({
    coreAdapter: ctx.coreAdapter,
    piiAdapter,
    tenantId: ctx.tenantId,
  });
  return userStore.findById(userId);
}
