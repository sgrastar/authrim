/**
 * Context Types
 *
 * Type-safe context layer for PII/Non-PII database separation.
 * Provides controlled access to repositories based on the handler's requirements.
 *
 * Architecture:
 * - AuthContext: Base context with Non-PII repositories only
 * - PIIContext: Extended context with PII repositories (requires explicit elevation)
 *
 * Usage:
 * ```typescript
 * // Handler that only needs Non-PII data
 * export async function handleAuthorize(ctx: AuthContext, c: Context) {
 *   const session = await ctx.repositories.session.findById(sessionId);
 *   // Cannot access ctx.piiRepositories - compile error
 * }
 *
 * // Handler that needs PII data
 * export async function handleUserInfo(ctx: PIIContext, c: Context) {
 *   const userCore = await ctx.repositories.userCore.findById(userId);
 *   const userPII = await ctx.piiRepositories.userPII.findByUserId(userId);
 * }
 * ```
 *
 * Benefits:
 * - Type-safe: Handlers declare their PII requirements at compile time
 * - Auditable: Code review shows "this handler accesses PII"
 * - Flexible: PIIContext can use different PII databases per partition
 */

import type { Context as HonoContext } from 'hono';
import type { DatabaseAdapter } from '../db/adapter';
import type { PIIPartitionRouter, PartitionKey } from '../db/partition-router';
import type {
  UserCoreRepository,
  ClientRepository,
  SessionRepository,
  PasskeyRepository,
  RoleRepository,
} from '../repositories/core';
import type {
  UserPIIRepository,
  TombstoneRepository,
  SubjectIdentifierRepository,
  LinkedIdentityRepository,
  PIIAuditLogRepository,
} from '../repositories/pii';

// =============================================================================
// Repository Types
// =============================================================================

/**
 * Core repositories (Non-PII data in D1_CORE)
 */
export interface CoreRepositories {
  /** User core data (pii_partition, pii_status, password_hash, etc.) */
  userCore: UserCoreRepository;

  /** OAuth 2.0 / OIDC clients */
  client: ClientRepository;

  /** User sessions with expiration handling */
  session: SessionRepository;

  /** WebAuthn passkey credentials */
  passkey: PasskeyRepository;

  /** RBAC roles and user-role assignments */
  role: RoleRepository;

  // Future repositories:
  // organization: OrganizationRepository;
}

/**
 * PII repositories (Personal information in D1_PII)
 */
export interface PIIRepositories {
  /** User PII data (email, name, address, etc.) */
  userPII: UserPIIRepository;

  /** GDPR deletion tracking */
  tombstone: TombstoneRepository;

  /** Pairwise subject identifiers (OIDC) */
  identifier: SubjectIdentifierRepository;

  /** External IdP linked identities */
  linkedIdentity: LinkedIdentityRepository;

  /** PII access audit log */
  auditLog: PIIAuditLogRepository;
}

// =============================================================================
// Context Types
// =============================================================================

/**
 * Base context with Non-PII repositories only.
 *
 * Used by handlers that don't need personal information:
 * - /authorize
 * - /token
 * - /introspect
 * - /revoke
 * - Most authentication endpoints
 *
 * This context cannot access PII data - attempting to do so will cause
 * a compile-time error, enforcing PII access control at the type level.
 */
export interface AuthContext {
  /** Tenant ID for multi-tenant support */
  tenantId: string;

  /** Core (Non-PII) repositories */
  repositories: CoreRepositories;

  /** Core database adapter */
  coreAdapter: DatabaseAdapter;

  /** Request-scoped cache for avoiding duplicate DB queries */
  cache: RequestScopedCache;

  /** Original Hono context (for request/env access) */
  honoContext: HonoContext;
}

/**
 * Extended context with PII repositories.
 *
 * Used by handlers that need personal information:
 * - /userinfo
 * - /admin/users
 * - GDPR data export/deletion
 * - Registration flows
 *
 * Must be explicitly created (not inherited) to ensure
 * PII access is intentional and auditable.
 */
export interface PIIContext extends AuthContext {
  /** PII repositories */
  piiRepositories: PIIRepositories;

  /** Partition router for PII database selection */
  partitionRouter: PIIPartitionRouter;

  /** Default PII database adapter */
  defaultPiiAdapter: DatabaseAdapter;

  /**
   * Get PII adapter for a specific partition.
   * Use this when accessing PII for a user with a known partition.
   *
   * @param partition - Partition key
   * @returns DatabaseAdapter for the partition
   */
  getPiiAdapter(partition: PartitionKey): DatabaseAdapter;
}

/**
 * Request-scoped cache for avoiding duplicate DB queries within a single request.
 *
 * Unlike KV cache (cross-request), this cache is cleared after each request.
 * Useful for:
 * - Caching user lookups when accessed multiple times in one handler
 * - Caching client lookups
 * - Avoiding N+1 query patterns
 */
export interface RequestScopedCache {
  /** Get cached value */
  get<T>(key: string): T | undefined;

  /** Set cached value */
  set<T>(key: string, value: T): void;

  /** Check if key exists */
  has(key: string): boolean;

  /** Delete cached value */
  delete(key: string): boolean;

  /** Clear all cached values */
  clear(): void;
}

// =============================================================================
// Handler Types
// =============================================================================

/**
 * Handler function type for routes that don't need PII.
 *
 * @example
 * const handleToken: AuthHandler = async (ctx, c) => {
 *   const client = await ctx.repositories.client.findById(clientId);
 *   // ...
 * };
 */
export type AuthHandler<T = Response> = (ctx: AuthContext, c: HonoContext) => Promise<T>;

/**
 * Handler function type for routes that need PII.
 *
 * @example
 * const handleUserInfo: PIIHandler = async (ctx, c) => {
 *   const userPII = await ctx.piiRepositories.userPII.findByUserId(userId);
 *   // ...
 * };
 */
export type PIIHandler<T = Response> = (ctx: PIIContext, c: HonoContext) => Promise<T>;

// =============================================================================
// Context Factory Options
// =============================================================================

/**
 * Options for creating contexts.
 */
export interface ContextFactoryOptions {
  /** Core database adapter */
  coreAdapter: DatabaseAdapter;

  /** Default PII database adapter */
  defaultPiiAdapter?: DatabaseAdapter;

  /** Partition router (required for PIIContext) */
  partitionRouter?: PIIPartitionRouter;

  /** Tenant ID (defaults to 'default') */
  tenantId?: string;
}

/**
 * Factory interface for creating contexts.
 */
export interface IContextFactory {
  /**
   * Create a base AuthContext (Non-PII only).
   *
   * @param c - Hono context
   * @returns AuthContext
   */
  createAuthContext(c: HonoContext): AuthContext;

  /**
   * Create a PIIContext (with PII access).
   *
   * @param c - Hono context
   * @returns PIIContext
   */
  createPIIContext(c: HonoContext): PIIContext;

  /**
   * Elevate an AuthContext to PIIContext.
   *
   * Use this when a handler starts without PII access
   * but needs to access PII conditionally.
   *
   * @param authCtx - Existing AuthContext
   * @returns PIIContext
   */
  elevateToPIIContext(authCtx: AuthContext): PIIContext;
}

// =============================================================================
// Request Scoped Cache Implementation
// =============================================================================

/**
 * Simple implementation of RequestScopedCache using Map.
 */
export class MapRequestScopedCache implements RequestScopedCache {
  private cache = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.cache.get(key) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.cache.set(key, value);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }
}
