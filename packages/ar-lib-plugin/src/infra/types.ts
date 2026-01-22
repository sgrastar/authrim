/**
 * Infrastructure Layer Types
 *
 * This module defines the interfaces for infrastructure components:
 * - Storage Infrastructure (KV, D1, Durable Objects, etc.)
 * - Policy Infrastructure (ReBAC, OpenFGA, OPA, etc.)
 *
 * These are NOT plugins - they are platform adapters that:
 * - Are configured at deploy time (not dynamically)
 * - Are shared across all Workers
 * - Support multi-cloud portability (Cloudflare, AWS, GCP, Azure)
 * - Handle GDPR and data localization requirements
 */

// =============================================================================
// Storage Infrastructure
// =============================================================================

/**
 * Storage Infrastructure Interface
 *
 * Unified interface for storage operations across different cloud providers.
 * Plugins access this through PluginContext.storage - they don't need to
 * know which provider is being used.
 */
export interface IStorageInfra {
  /** Cloud provider identifier */
  readonly provider: StorageProvider;

  // --------------------------------------------------------------------------
  // Store Interfaces (access to individual data stores)
  // --------------------------------------------------------------------------

  /** User data store */
  readonly user: IUserStore;

  /** OAuth client data store */
  readonly client: IClientStore;

  /** Session data store */
  readonly session: ISessionStore;

  /** Passkey credential store */
  readonly passkey: IPasskeyStore;

  // --------------------------------------------------------------------------
  // RBAC Stores
  // --------------------------------------------------------------------------

  /** Organization store */
  readonly organization: IOrganizationStore;

  /** Role store */
  readonly role: IRoleStore;

  /** Role assignment store */
  readonly roleAssignment: IRoleAssignmentStore;

  /** Relationship store */
  readonly relationship: IRelationshipStore;

  // --------------------------------------------------------------------------
  // Raw Adapter (for advanced use cases)
  // --------------------------------------------------------------------------

  /** Direct access to storage adapter (for migrations, custom queries) */
  readonly adapter: IStorageAdapter;

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /** Initialize storage infrastructure */
  initialize(env: InfraEnv): Promise<void>;

  /** Health check */
  healthCheck(): Promise<InfraHealthStatus>;

  /** Shutdown (cleanup connections) */
  shutdown?(): Promise<void>;
}

export type StorageProvider = 'cloudflare' | 'aws' | 'gcp' | 'azure' | 'custom';

// =============================================================================
// Policy Infrastructure
// =============================================================================

/**
 * Policy Infrastructure Interface
 *
 * Unified interface for authorization decisions across different policy engines.
 * Supports built-in ReBAC, OpenFGA, and OPA backends.
 */
export interface IPolicyInfra {
  /** Policy engine identifier */
  readonly provider: PolicyProvider;

  // --------------------------------------------------------------------------
  // Check API (Zanzibar-style)
  // --------------------------------------------------------------------------

  /** Check if a subject has a relation to an object */
  check(request: CheckRequest): Promise<CheckResponse>;

  /** Batch check multiple relations */
  batchCheck(request: BatchCheckRequest): Promise<BatchCheckResponse>;

  // --------------------------------------------------------------------------
  // List API
  // --------------------------------------------------------------------------

  /** List objects a subject has access to */
  listObjects(request: ListObjectsRequest): Promise<ListObjectsResponse>;

  /** List subjects that have access to an object */
  listUsers(request: ListUsersRequest): Promise<ListUsersResponse>;

  // --------------------------------------------------------------------------
  // Rule Evaluation (Authrim-specific)
  // --------------------------------------------------------------------------

  /** Evaluate role assignment rules (for JIT provisioning, etc.) */
  evaluateRules(context: RuleEvaluationContext): Promise<RuleEvaluationResult>;

  // --------------------------------------------------------------------------
  // Cache Management
  // --------------------------------------------------------------------------

  /** Invalidate cached authorization decisions */
  invalidateCache(keys: CacheInvalidationRequest): Promise<void>;

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /** Initialize policy infrastructure */
  initialize(env: InfraEnv, storage: IStorageInfra): Promise<void>;

  /** Health check */
  healthCheck(): Promise<InfraHealthStatus>;
}

export type PolicyProvider = 'builtin' | 'openfga' | 'opa' | 'custom';

// =============================================================================
// Infrastructure Health Status
// =============================================================================

export interface InfraHealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  provider: string;
  latencyMs?: number;
  message?: string;
  details?: Record<string, unknown>;
}

// =============================================================================
// Infrastructure Environment
// =============================================================================

/**
 * Environment bindings for infrastructure initialization
 */
export interface InfraEnv {
  // KV Namespaces
  AUTHRIM_CONFIG?: KVNamespace;
  USER_CACHE?: KVNamespace;
  REBAC_CACHE?: KVNamespace;

  // D1 Databases
  DB?: D1Database;
  DB_PII?: D1Database;

  // Durable Objects
  SESSION_STORE?: DurableObjectNamespace;
  KEY_MANAGER?: DurableObjectNamespace;
  AUTHORIZATION_CODE_STORE?: DurableObjectNamespace;
  REFRESH_TOKEN_ROTATOR?: DurableObjectNamespace;
  REBAC_CLOSURE?: DurableObjectNamespace;

  // Environment
  ENVIRONMENT?: string;

  // Storage provider config
  STORAGE_PROVIDER?: StorageProvider;
  POLICY_PROVIDER?: PolicyProvider;

  // Policy engine configuration
  /** ReBAC cache TTL in seconds (default: 60, max: 3600) */
  REBAC_CACHE_TTL_SECONDS?: number | string;

  // Additional bindings
  [key: string]: unknown;
}

// =============================================================================
// Store Classification (PII vs Non-PII)
// =============================================================================

/**
 * Marker interface for stores that access PII data
 *
 * Stores with this marker:
 * - Access DB_PII (separate D1 database for personal data)
 * - Contain user personal information (email, name, phone, etc.)
 * - Subject to GDPR and data localization requirements
 *
 * Used for documentation and potential future tooling/linting.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PIIStore {}

/**
 * Marker interface for stores that access non-PII data
 *
 * Stores with this marker:
 * - Access DB (core D1 database)
 * - Contain no personally identifiable information
 * - Safe to replicate across regions without GDPR concerns
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface NonPIIStore {}

// =============================================================================
// Storage Adapter Interface
// =============================================================================

/**
 * Low-level storage adapter interface
 *
 * Used internally by store implementations. Plugins should use the
 * higher-level store interfaces instead.
 *
 * @internal - Not exposed to plugins via PluginContext
 */
export interface IStorageAdapter {
  /** Get a value by key */
  get(key: string): Promise<string | null>;

  /** Set a value with optional TTL */
  set(key: string, value: string, ttl?: number): Promise<void>;

  /** Delete a value */
  delete(key: string): Promise<void>;

  /** Execute a SQL query (D1) */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;

  /** Execute a SQL query and return single result */
  queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null>;

  /** Execute a SQL statement (D1) */
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;

  /** Execute multiple statements in a transaction */
  transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

export interface ExecuteResult {
  success: boolean;
  rowsAffected?: number;
  lastRowId?: number;
}

export interface TransactionContext {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;
}

// =============================================================================
// User Store Interface
// =============================================================================

/**
 * User data store
 *
 * @pii - Contains personally identifiable information (email, name, phone)
 */
export interface IUserStore extends PIIStore {
  get(userId: string): Promise<User | null>;
  getByEmail(email: string): Promise<User | null>;
  create(user: Partial<User>): Promise<User>;
  update(userId: string, updates: Partial<User>): Promise<User>;
  delete(userId: string): Promise<void>;
}

export interface User {
  id: string;
  email: string;
  email_verified: boolean;
  password_hash?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  phone_number?: string;
  phone_number_verified?: boolean;
  mfa_enabled?: boolean;
  is_active: boolean;
  created_at: number;
  updated_at: number;
  last_login_at?: number;
}

// =============================================================================
// Client Store Interface
// =============================================================================

/**
 * OAuth client data store
 *
 * @non-pii - Contains only client configuration, no user data
 */
export interface IClientStore extends NonPIIStore {
  get(clientId: string): Promise<OAuthClient | null>;
  create(client: Partial<OAuthClient>): Promise<OAuthClient>;
  update(clientId: string, updates: Partial<OAuthClient>): Promise<OAuthClient>;
  delete(clientId: string): Promise<void>;
  list(options?: { limit?: number; offset?: number }): Promise<OAuthClient[]>;
}

export interface OAuthClient {
  client_id: string;
  client_secret_hash?: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scope?: string;
  subject_type?: 'public' | 'pairwise';
  jwks?: { keys: unknown[] };
  jwks_uri?: string;
  created_at: number;
  updated_at: number;
  [key: string]: unknown;
}

// =============================================================================
// Session Store Interface
// =============================================================================

/**
 * Session data store
 *
 * @pii - Contains user_agent and ip_address (considered PII in some jurisdictions)
 */
export interface ISessionStore extends PIIStore {
  get(sessionId: string): Promise<Session | null>;
  create(session: Partial<Session>): Promise<Session>;
  update(sessionId: string, updates: Partial<Session>): Promise<Session>;
  delete(sessionId: string): Promise<void>;
  deleteAllForUser(userId: string): Promise<void>;
  listByUser(userId: string): Promise<Session[]>;
  extend(sessionId: string, additionalSeconds: number): Promise<Session | null>;
}

export interface Session {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_activity_at: number;
  user_agent?: string;
  ip_address?: string;
  amr?: string[];
  acr?: string;
  data?: Record<string, unknown>;
}

// =============================================================================
// Passkey Store Interface
// =============================================================================

/**
 * Passkey credential store
 *
 * @non-pii - Contains only credential data (public keys, counters), no user PII
 */
export interface IPasskeyStore extends NonPIIStore {
  getByCredentialId(credentialId: string): Promise<Passkey | null>;
  listByUser(userId: string): Promise<Passkey[]>;
  create(passkey: Partial<Passkey>): Promise<Passkey>;
  updateCounter(passkeyId: string, counter: number): Promise<Passkey>;
  delete(passkeyId: string): Promise<void>;
}

export interface Passkey {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports?: string[];
  device_name?: string;
  created_at: number;
  last_used_at?: number;
}

// =============================================================================
// RBAC Store Interfaces
// =============================================================================

/**
 * Organization store
 *
 * @non-pii - Contains organizational hierarchy, no user PII
 */
export interface IOrganizationStore extends NonPIIStore {
  get(orgId: string): Promise<Organization | null>;
  getByName(tenantId: string, name: string): Promise<Organization | null>;
  create(org: Partial<Organization>): Promise<Organization>;
  update(orgId: string, updates: Partial<Organization>): Promise<Organization>;
  delete(orgId: string): Promise<void>;
  list(tenantId: string, options?: { limit?: number; offset?: number }): Promise<Organization[]>;
}

export interface Organization {
  id: string;
  tenant_id: string;
  name: string;
  display_name?: string;
  parent_org_id?: string;
  metadata?: Record<string, unknown>;
  is_active: boolean;
  created_at: number;
  updated_at: number;
}

/**
 * Role store
 *
 * @non-pii - Contains role definitions, no user PII
 */
export interface IRoleStore extends NonPIIStore {
  get(roleId: string): Promise<Role | null>;
  getByName(tenantId: string, name: string): Promise<Role | null>;
  create(role: Partial<Role>): Promise<Role>;
  update(roleId: string, updates: Partial<Role>): Promise<Role>;
  delete(roleId: string): Promise<void>;
  list(tenantId: string, options?: { limit?: number; offset?: number }): Promise<Role[]>;
}

export interface Role {
  id: string;
  tenant_id: string;
  name: string;
  display_name?: string;
  description?: string;
  permissions?: string[];
  parent_role_id?: string;
  is_active: boolean;
  created_at: number;
}

/**
 * Role assignment store
 *
 * @non-pii - Contains role-subject mappings (subject_id is opaque ID, not PII)
 */
export interface IRoleAssignmentStore extends NonPIIStore {
  get(assignmentId: string): Promise<RoleAssignment | null>;
  create(assignment: Partial<RoleAssignment>): Promise<RoleAssignment>;
  update(assignmentId: string, updates: Partial<RoleAssignment>): Promise<RoleAssignment>;
  delete(assignmentId: string): Promise<void>;
  listBySubject(subjectId: string): Promise<RoleAssignment[]>;
  listByRole(roleId: string): Promise<RoleAssignment[]>;
  getEffectiveRoles(subjectId: string): Promise<string[]>;
  hasRole(subjectId: string, roleName: string): Promise<boolean>;
}

export interface RoleAssignment {
  id: string;
  subject_id: string;
  role_id: string;
  scope_type?: 'global' | 'organization' | 'resource';
  scope_target?: string;
  granted_by?: string;
  expires_at?: number;
  created_at: number;
  updated_at: number;
}

/**
 * Relationship store (for ReBAC)
 *
 * @non-pii - Contains entity relationships, no user PII
 */
export interface IRelationshipStore extends NonPIIStore {
  get(relationshipId: string): Promise<Relationship | null>;
  create(relationship: Partial<Relationship>): Promise<Relationship>;
  update(relationshipId: string, updates: Partial<Relationship>): Promise<Relationship>;
  delete(relationshipId: string): Promise<void>;
  listFrom(fromType: string, fromId: string): Promise<Relationship[]>;
  listTo(toType: string, toId: string): Promise<Relationship[]>;
  find(
    fromType: string,
    fromId: string,
    toType: string,
    toId: string,
    relationshipType: string
  ): Promise<Relationship | null>;
}

export interface Relationship {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  relationship_type: string;
  metadata?: Record<string, unknown>;
  expires_at?: number;
  created_at: number;
  updated_at: number;
}

// =============================================================================
// Policy Check Types (Zanzibar-style)
// =============================================================================

export interface CheckRequest {
  subject: string; // e.g., "user:123"
  relation: string; // e.g., "viewer", "editor", "owner"
  object: string; // e.g., "document:456"
  context?: Record<string, unknown>;
}

export interface CheckResponse {
  allowed: boolean;
  resolution_method?: 'direct' | 'inherited' | 'computed';
  cached?: boolean;
}

export interface BatchCheckRequest {
  checks: CheckRequest[];
}

export interface BatchCheckResponse {
  results: CheckResponse[];
}

export interface ListObjectsRequest {
  subject: string;
  relation: string;
  objectType: string;
  limit?: number;
  cursor?: string;
}

export interface ListObjectsResponse {
  objects: string[];
  cursor?: string;
}

export interface ListUsersRequest {
  object: string;
  relation: string;
  limit?: number;
  cursor?: string;
}

export interface ListUsersResponse {
  users: string[];
  cursor?: string;
}

// =============================================================================
// Rule Evaluation Types
// =============================================================================

export interface RuleEvaluationContext {
  tenant_id: string;
  email_domain_hash?: string;
  email_verified: boolean;
  idp_claims: Record<string, unknown>;
  provider_id: string;
  user_type?: string;
}

export interface RuleEvaluationResult {
  matched_rules: string[];
  roles_to_assign: string[];
  orgs_to_join: string[];
  attributes_to_set: Array<{ key: string; value: unknown }>;
  denied: boolean;
  deny_reason?: string;
}

// =============================================================================
// Cache Invalidation
// =============================================================================

export interface CacheInvalidationRequest {
  /** Specific keys to invalidate */
  keys?: string[];

  /** Pattern to match (e.g., "user:123:*") */
  pattern?: string;

  /** Invalidate all cache */
  all?: boolean;
}
