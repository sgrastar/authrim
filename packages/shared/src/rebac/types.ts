/**
 * ReBAC (Relationship-Based Access Control) Type Definitions
 *
 * This module contains type definitions for Phase 3 ReBAC implementation:
 * - Check API request/response types
 * - Relation DSL types (union, tuple-to-userset)
 * - Closure table types
 * - Cache key types
 *
 * Based on Zanzibar-lite design:
 * - check() uses recursive CTE + KV cache
 * - listObjects/listUsers uses closure table
 * - Phase 3: Allow only (no Deny)
 * - Phase 3: MVP DSL (union, tuple-to-userset)
 */

// =============================================================================
// Check API Types
// =============================================================================

/**
 * Check request - "Can user X perform relation Y on object Z?"
 */
export interface CheckRequest {
  /** Tenant ID for multi-tenant isolation */
  tenant_id: string;
  /** Subject (user) identifier - can be "user:user_123" or just "user_123" */
  user_id: string;
  /** Relation to check - "viewer", "editor", "owner", etc. */
  relation: string;
  /** Object identifier - can be "document:doc_456" or structured */
  object: string;
  /** Optional: Object type if not embedded in object string */
  object_type?: string;
  /** Optional: Context for conditional checks (Phase 4+) */
  context?: Record<string, unknown>;
}

/**
 * Check response
 */
export interface CheckResponse {
  /** Whether the check is allowed */
  allowed: boolean;
  /** How the result was resolved (for debugging/logging) */
  resolved_via?: CheckResolutionMethod;
  /** Path through relationships (for debugging) */
  path?: string[];
  /** Cached until timestamp (for debugging) */
  cached_until?: number;
}

/**
 * How a check was resolved
 */
export type CheckResolutionMethod =
  | 'direct' // Direct relationship found
  | 'computed' // Computed via relation definition (union, tuple-to-userset)
  | 'cache' // Resolved from KV cache
  | 'closure'; // Resolved from closure table (listObjects/listUsers only)

/**
 * Batch check request
 */
export interface BatchCheckRequest {
  /** Array of check requests */
  checks: CheckRequest[];
}

/**
 * Batch check response
 */
export interface BatchCheckResponse {
  /** Array of check responses (same order as requests) */
  results: CheckResponse[];
}

// =============================================================================
// Relation DSL Types (Zanzibar-style)
// =============================================================================

/**
 * Base type for all relation expressions
 */
export type RelationExpression =
  | DirectRelation
  | UnionRelation
  | TupleToUsersetRelation
  | IntersectionRelation // Phase 4+
  | ExclusionRelation; // Phase 4+

/**
 * Direct relation - matches a specific relation tuple
 * Example: { type: "direct", relation: "viewer" }
 */
export interface DirectRelation {
  type: 'direct';
  /** The relation name to match */
  relation: string;
}

/**
 * Union relation - OR of multiple expressions
 * Example: viewer = owner OR editor OR direct viewer
 */
export interface UnionRelation {
  type: 'union';
  /** Child expressions (any must match) */
  children: RelationExpression[];
}

/**
 * Tuple-to-userset - inherit from related object
 * Example: document#parent.viewer (viewers of parent folder are viewers of document)
 */
export interface TupleToUsersetRelation {
  type: 'tuple_to_userset';
  /** The relation to traverse to find the related object */
  tupleset: {
    relation: string; // e.g., "parent"
  };
  /** The relation to check on the related object */
  computed_userset: {
    relation: string; // e.g., "viewer"
  };
}

/**
 * Intersection relation - AND of multiple expressions (Phase 4+)
 */
export interface IntersectionRelation {
  type: 'intersection';
  /** Child expressions (all must match) */
  children: RelationExpression[];
}

/**
 * Exclusion relation - NOT expression (Phase 4+)
 */
export interface ExclusionRelation {
  type: 'exclusion';
  /** Base expression */
  base: RelationExpression;
  /** Expression to exclude */
  subtract: RelationExpression;
}

/**
 * Relation definition - defines how a relation is computed for an object type
 */
export interface RelationDefinition {
  /** Unique definition ID */
  id: string;
  /** Tenant ID for multi-tenant isolation */
  tenant_id: string;
  /** Object type this definition applies to */
  object_type: string;
  /** Relation name being defined */
  relation_name: string;
  /** The relation expression (JSON stored in definition_json) */
  definition: RelationExpression;
  /** Human-readable description */
  description?: string;
  /** Evaluation priority (higher = evaluated first) */
  priority: number;
  /** Whether this definition is active */
  is_active: boolean;
  /** Creation timestamp */
  created_at: number;
  /** Last update timestamp */
  updated_at: number;
}

/**
 * Relation definition row from D1 database
 */
export interface RelationDefinitionRow {
  id: string;
  tenant_id: string;
  object_type: string;
  relation_name: string;
  definition_json: string;
  description: string | null;
  priority: number;
  is_active: number;
  created_at: number;
  updated_at: number;
}

// =============================================================================
// Closure Table Types
// =============================================================================

/**
 * Closure entry - pre-computed transitive relationship
 */
export interface ClosureEntry {
  /** Unique closure entry ID */
  id: string;
  /** Tenant ID for multi-tenant isolation */
  tenant_id: string;
  /** Ancestor (source) entity type */
  ancestor_type: string;
  /** Ancestor (source) entity ID */
  ancestor_id: string;
  /** Descendant (target) entity type */
  descendant_type: string;
  /** Descendant (target) entity ID */
  descendant_id: string;
  /** Computed relation */
  relation: string;
  /** Number of hops (0 = direct) */
  depth: number;
  /** Path through relationships (array of relationship IDs) */
  path?: string[];
  /** Most restrictive permission in path */
  effective_permission?: string;
  /** Creation timestamp */
  created_at: number;
  /** Last update timestamp */
  updated_at: number;
}

/**
 * Closure entry row from D1 database
 */
export interface ClosureEntryRow {
  id: string;
  tenant_id: string;
  ancestor_type: string;
  ancestor_id: string;
  descendant_type: string;
  descendant_id: string;
  relation: string;
  depth: number;
  path_json: string | null;
  effective_permission: string | null;
  created_at: number;
  updated_at: number;
}

// =============================================================================
// Cache Types
// =============================================================================

/**
 * Cache key components for ReBAC check results
 */
export interface CheckCacheKey {
  tenant_id: string;
  user_id: string;
  relation: string;
  object_type: string;
  object_id: string;
}

/**
 * Cached check result
 */
export interface CachedCheckResult {
  allowed: boolean;
  resolved_via: CheckResolutionMethod;
  path?: string[];
  cached_at: number;
  expires_at: number;
}

// =============================================================================
// List API Types
// =============================================================================

/**
 * List objects request - "What objects can user X access with relation Y?"
 */
export interface ListObjectsRequest {
  tenant_id: string;
  user_id: string;
  relation: string;
  object_type: string;
  /** Maximum number of results */
  limit?: number;
  /** Pagination cursor */
  cursor?: string;
}

/**
 * List objects response
 */
export interface ListObjectsResponse {
  /** Object IDs the user has the relation to */
  object_ids: string[];
  /** Pagination cursor for next page */
  next_cursor?: string;
}

/**
 * List users request - "Who has relation Y on object Z?"
 */
export interface ListUsersRequest {
  tenant_id: string;
  object: string;
  object_type?: string;
  relation: string;
  /** Maximum number of results */
  limit?: number;
  /** Pagination cursor */
  cursor?: string;
}

/**
 * List users response
 */
export interface ListUsersResponse {
  /** User IDs that have the relation to the object */
  user_ids: string[];
  /** Pagination cursor for next page */
  next_cursor?: string;
}

// =============================================================================
// Relationship Tuple Types (for consistency with Zanzibar terminology)
// =============================================================================

/**
 * A relationship tuple - the fundamental unit of ReBAC
 * Format: object#relation@user
 * Example: document:doc_123#viewer@user:user_456
 */
export interface RelationshipTuple {
  /** Object type (e.g., "document") */
  object_type: string;
  /** Object ID (e.g., "doc_123") */
  object_id: string;
  /** Relation (e.g., "viewer") */
  relation: string;
  /** Subject type (e.g., "user", "group") */
  subject_type: string;
  /** Subject ID (e.g., "user_456") */
  subject_id: string;
  /** Optional: Subject relation (for userset subjects) */
  subject_relation?: string;
}

/**
 * Parse an object string into type and ID
 * "document:doc_123" → { type: "document", id: "doc_123" }
 */
export interface ParsedObject {
  type: string;
  id: string;
}

// =============================================================================
// ReBAC Service Configuration
// =============================================================================

/**
 * Configuration for ReBAC service
 */
export interface ReBACConfig {
  /** KV namespace for caching */
  cache_namespace?: KVNamespace;
  /** Cache TTL in seconds (default: 60) */
  cache_ttl?: number;
  /** Maximum recursion depth for CTE (default: 5) */
  max_depth?: number;
  /** Whether to enable closure table for list operations */
  enable_closure_table?: boolean;
  /** Batch size for closure table updates */
  closure_batch_size?: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Default cache TTL in seconds */
export const DEFAULT_CACHE_TTL = 60;

/** Maximum recursion depth for relationship traversal */
export const DEFAULT_MAX_DEPTH = 5;

/** Cache key prefix for ReBAC */
export const REBAC_CACHE_PREFIX = 'rebac:check:';

/** Closure table batch size */
export const DEFAULT_CLOSURE_BATCH_SIZE = 100;
