/**
 * ReBAC (Relationship-Based Access Control) Interfaces
 *
 * This module defines the service interfaces for ReBAC operations.
 * Based on Zanzibar-lite design with the following characteristics:
 *
 * - check(): direct tuples, group usersets and relation definitions + KV cache
 * - listObjects/listUsers: direct subject tuples only (no usersets, no computed relations)
 * - Relation DSL: direct, union, tuple-to-userset, intersection, exclusion
 */

import type {
  CheckRequest,
  CheckResponse,
  BatchCheckRequest,
  BatchCheckResponse,
  ListObjectsRequest,
  ListObjectsResponse,
  ListUsersRequest,
  ListUsersResponse,
  RelationDefinition,
  ReBACConfig,
  ReBACCheckOptions,
  RelationExpression,
} from './types';
import type { IStorageAdapter } from '../storage/interfaces';

// =============================================================================
// Main ReBAC Service Interface
// =============================================================================

/**
 * IReBACService - Main interface for ReBAC operations
 *
 * Provides Zanzibar-style access control with:
 * - check(): Authorization check with caching
 * - batchCheck(): Multiple checks in one call
 * - listObjects(): What objects can a user access?
 * - listUsers(): Who has access to an object?
 */
export interface IReBACService {
  /**
   * Check if a user has a specific relation to an object
   *
   * Resolution order:
   * 1. Request-scoped cache (same request dedup)
   * 2. KV cache (TTL: 60s; results that depend on group memberships are not cached)
   * 3. Direct tuple / group userset, then the relation definition (see rebac-service.ts)
   *
   * @param request - Check request containing user, relation, and object
   * @returns Check response with allowed status and resolution metadata
   *
   * @example
   * ```typescript
   * const result = await rebacService.check({
   *   tenant_id: 'tenant_123',
   *   user_id: 'user_456',
   *   relation: 'viewer',
   *   object: 'document:doc_789',
   * });
   * // { allowed: true, resolved_via: 'computed' }
   * ```
   */
  check(request: CheckRequest, options?: ReBACCheckOptions): Promise<CheckResponse>;

  /**
   * Check multiple authorization requests in a single call
   *
   * Optimized for batch operations with shared caching.
   *
   * @param request - Batch of check requests
   * @returns Batch response with results in same order as requests
   */
  batchCheck(request: BatchCheckRequest): Promise<BatchCheckResponse>;

  /**
   * List all objects a user has a specific relation to
   *
   * Direct subject tuples only (see rebac-service.ts).
   *
   * @param request - List objects request
   * @returns List of object IDs the user has access to
   *
   * @example
   * ```typescript
   * const result = await rebacService.listObjects({
   *   tenant_id: 'tenant_123',
   *   user_id: 'user_456',
   *   relation: 'viewer',
   *   object_type: 'document',
   * });
   * // { object_ids: ['doc_1', 'doc_2', 'doc_3'], userset_subjects_omitted: false }
   * ```
   */
  listObjects(request: ListObjectsRequest): Promise<ListObjectsResponse>;

  /**
   * List all users who have a specific relation to an object
   *
   * Direct subject tuples only (see rebac-service.ts).
   *
   * @param request - List users request
   * @returns List of user IDs with the relation
   */
  listUsers(request: ListUsersRequest): Promise<ListUsersResponse>;

  /**
   * Invalidate cache for a specific check
   *
   * Called when relationships change.
   *
   * @param tenantId - Tenant ID
   * @param objectType - Object type
   * @param objectId - Object ID
   * @param relation - Optional: specific relation to invalidate
   */
  invalidateCache(
    tenantId: string,
    objectType: string,
    objectId: string,
    relation?: string
  ): Promise<void>;

  /**
   * Invalidate all cache entries for a user
   *
   * @param tenantId - Tenant ID
   * @param userId - User ID
   */
  invalidateUserCache(tenantId: string, userId: string): Promise<void>;
}

// =============================================================================
// Relation Definition Store Interface
// =============================================================================

/**
 * IRelationDefinitionStore - Manages relation definitions (DSL)
 */
export interface IRelationDefinitionStore {
  /**
   * Get a relation definition by ID
   */
  getDefinition(definitionId: string): Promise<RelationDefinition | null>;

  /**
   * Get relation definition for a specific object type and relation
   */
  getDefinitionByTypeAndRelation(
    tenantId: string,
    objectType: string,
    relationName: string
  ): Promise<RelationDefinition | null>;

  /**
   * List all definitions for an object type
   */
  listDefinitionsByObjectType(tenantId: string, objectType: string): Promise<RelationDefinition[]>;

  /**
   * Create a new relation definition
   */
  createDefinition(
    definition: Omit<RelationDefinition, 'id' | 'created_at' | 'updated_at'>
  ): Promise<RelationDefinition>;

  /**
   * Update a relation definition
   */
  updateDefinition(
    definitionId: string,
    updates: Partial<RelationDefinition>
  ): Promise<RelationDefinition>;

  /**
   * Delete a relation definition
   */
  deleteDefinition(definitionId: string): Promise<void>;
}

// =============================================================================
// Closure Manager Interface
// =============================================================================

/**
 * IClosureManager - Manages the closure table for list operations
 *
 * The closure table stores pre-computed transitive relationships
 * for efficient listObjects/listUsers queries.
 */
export interface IClosureManager {
  /**
   * Get all objects a user has access to (via closure table)
   */
  getObjectsForUser(
    tenantId: string,
    userId: string,
    relation: string,
    objectType: string,
    options?: { limit?: number; cursor?: string }
  ): Promise<{ objectIds: string[]; nextCursor?: string }>;

  /**
   * Get all users who have access to an object (via closure table)
   */
  getUsersForObject(
    tenantId: string,
    objectType: string,
    objectId: string,
    relation: string,
    options?: { limit?: number; cursor?: string }
  ): Promise<{ userIds: string[]; nextCursor?: string }>;

  /**
   * Recompute closure for a specific object
   *
   * Called when relationships to/from this object change.
   */
  recomputeForObject(tenantId: string, objectType: string, objectId: string): Promise<void>;

  /**
   * Recompute closure for a specific user
   *
   * Called when relationships from this user change.
   */
  recomputeForUser(tenantId: string, userId: string): Promise<void>;

  /**
   * Batch recompute closure entries
   *
   * Used for bulk updates or initial population.
   */
  batchRecompute(
    tenantId: string,
    entries: Array<{ type: 'user' | 'object'; entityType: string; entityId: string }>
  ): Promise<void>;

  /**
   * Delete closure entries for an object
   */
  deleteForObject(tenantId: string, objectType: string, objectId: string): Promise<void>;

  /**
   * Delete closure entries for a user
   */
  deleteForUser(tenantId: string, userId: string): Promise<void>;
}

// =============================================================================
// Cache Manager Interface
// =============================================================================

/**
 * IReBACCacheManager - Manages KV caching for check() operations
 */
export interface IReBACCacheManager {
  /**
   * Get cached check result
   *
   * @returns Cached result or null if not found/expired
   */
  get(
    tenantId: string,
    userId: string,
    relation: string,
    objectType: string,
    objectId: string
  ): Promise<CheckResponse | null>;

  /**
   * Set cached check result
   *
   * @param ttl - Time-to-live in seconds (default: 60)
   */
  set(
    tenantId: string,
    userId: string,
    relation: string,
    objectType: string,
    objectId: string,
    result: CheckResponse,
    ttl?: number
  ): Promise<void>;

  /**
   * Invalidate cache for a specific check
   */
  invalidate(
    tenantId: string,
    userId: string,
    relation: string,
    objectType: string,
    objectId: string
  ): Promise<void>;

  /**
   * Invalidate all cache entries matching a pattern
   *
   * @param pattern - Pattern to match (e.g., "tenant:*:user:*:relation:viewer")
   */
  invalidatePattern(pattern: string): Promise<void>;

  /**
   * Invalidate all cache entries for an object
   */
  invalidateObject(tenantId: string, objectType: string, objectId: string): Promise<void>;

  /**
   * Invalidate all cache entries for a user
   */
  invalidateUser(tenantId: string, userId: string): Promise<void>;
}

// =============================================================================
// Relation Parser Interface
// =============================================================================

/**
 * IRelationParser - Parses and evaluates relation expressions (DSL)
 */
export interface IRelationParser {
  /**
   * Parse a JSON relation expression
   *
   * @param json - JSON string or object representing the expression
   * @returns Parsed RelationExpression
   * @throws Error if the expression is invalid
   */
  parse(json: string | object): RelationExpression;

  /**
   * Validate a relation expression
   *
   * @returns Array of validation errors (empty if valid)
   */
  validate(expression: RelationExpression): string[];

  /**
   * Evaluate a relation expression to determine if it matches
   *
   * This is used during check() to resolve computed relations.
   *
   * @param expression - The relation expression to evaluate
   * @param context - Evaluation context (tenant, user, object, etc.)
   * @param adapter - Storage adapter for querying relationships
   * @returns Whether the expression matches
   */
  evaluate(
    expression: RelationExpression,
    context: RelationEvaluationContext,
    adapter: IStorageAdapter
  ): Promise<boolean>;

  /**
   * Evaluate a relation of an object as a check does (its active definition, or direct tuples
   * and group usersets without one), in three values.
   */
  evaluateRelation(
    objectType: string,
    objectId: string,
    relation: string,
    context: RelationEvaluationContext,
    adapter: IStorageAdapter
  ): Promise<EvaluationResult>;
}

/**
 * Context for evaluating relation expressions
 */
export interface RelationEvaluationContext {
  tenant_id: string;
  user_id: string;
  user_type: string;
  object_type: string;
  object_id: string;
  /** Current depth in recursion (for limiting) */
  depth: number;
  /** Maximum allowed depth */
  max_depth: number;
  /**
   * The relations on the current recursion path (`type:id#relation`): a relation met again on
   * the same path is a cycle (undecided). Each branch has its own copy, so a sibling branch that
   * evaluates the same relation is not mistaken for a cycle.
   */
  visited: Set<string>;
  /**
   * The subject's groups for group usersets, read once per check (unset: no userset can be
   * decided; see userset.ts).
   */
  subject_groups?: SubjectGroupsLookup;
  /** What the check met (shared by every context of one check). */
  membership?: MembershipTrace;
  /**
   * Set while evaluating under an odd number of exclusion `subtract`s: a "no" there turns into a
   * "yes", so what cannot be trusted as a "no" (a dynamic group's non-membership) is undecided.
   */
  negative?: boolean;
  /** Request-specific tuples of the subject, seen by every `direct` lookup of the check. */
  contextual?: ReadonlyArray<{ relation: string; object_type: string; object_id: string }>;
  /** The active definition of a relation (memoised per check; see definitions.ts). */
  definitions?: (objectType: string, relation: string) => Promise<ActiveDefinition>;
  /**
   * The groups whose non-membership cannot be trusted (service-group owned, or above one):
   * read once per check, only when a subtract needs it.
   */
  service_decided_groups?: () => Promise<Set<string>>;
}

/** The subject's effective and unknown groups, read once per check. */
export type SubjectGroupsLookup = () => Promise<{ effective: Set<string>; unknown: Set<string> }>;

/** A three-valued evaluation result: `unknown` grants nothing and is never cached. */
export type EvaluationResult = 'allow' | 'deny' | 'unknown';

/** What a check met. */
export interface MembershipTrace {
  /** A group userset was on the path (the subject's memberships were consulted). */
  consulted: boolean;
  /** A group userset on the path could not be decided. */
  unknown: boolean;
  /** A cycle, the depth limit, or an unusable definition left part of the check undecided. */
  indeterminate: boolean;
  /** The earliest `expires_at` (seconds) of the tuples the evaluation read and relied on. */
  minExpiresAt: number | null;
  /** The grants that allowed (for the response path). */
  grants: string[];
}

/** A relation's active definition as a check uses it: none, usable, or stored unusable. */
export type ActiveDefinition =
  | { state: 'none' }
  | { state: 'usable'; definition: RelationDefinition; exclusive: boolean; computed: boolean }
  | { state: 'unusable' };

// =============================================================================
// Factory Interface
// =============================================================================

/**
 * Factory for creating ReBAC service instances
 */
export interface IReBACServiceFactory {
  /**
   * Create a ReBAC service instance
   *
   * @param adapter - Storage adapter (D1)
   * @param config - Service configuration
   * @returns ReBAC service instance
   */
  create(adapter: IStorageAdapter, config?: ReBACConfig): IReBACService;

  /**
   * Create a relation definition store
   */
  createDefinitionStore(adapter: IStorageAdapter): IRelationDefinitionStore;

  /**
   * Create a closure manager
   */
  createClosureManager(adapter: IStorageAdapter): IClosureManager;

  /**
   * Create a cache manager
   */
  createCacheManager(kv?: KVNamespace): IReBACCacheManager;

  /**
   * Create a relation parser
   */
  createRelationParser(): IRelationParser;
}

// =============================================================================
// Extended Relationship Store Interface (adds evidence support)
// =============================================================================

/**
 * Extended relationship data with evidence tracking
 */
export interface RelationshipWithEvidence {
  id: string;
  tenant_id: string;
  relationship_type: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  permission_level: string;
  expires_at?: number;
  is_bidirectional: boolean;
  metadata_json?: string;
  /** Evidence type: 'manual', 'vc', 'external_assertion' */
  evidence_type: string;
  /** Reference to evidence (VC ID, external system ID, etc.) */
  evidence_ref?: string;
  created_at: number;
  updated_at: number;
}

/**
 * IRelationshipStoreExtended - Extended relationship store with evidence support
 */
export interface IRelationshipStoreExtended {
  /**
   * Create a relationship with evidence tracking
   */
  createRelationshipWithEvidence(
    relationship: Omit<RelationshipWithEvidence, 'id' | 'created_at' | 'updated_at'>
  ): Promise<RelationshipWithEvidence>;

  /**
   * List relationships by evidence type
   */
  listRelationshipsByEvidenceType(
    tenantId: string,
    evidenceType: string,
    options?: { limit?: number; offset?: number }
  ): Promise<RelationshipWithEvidence[]>;

  /**
   * Get relationships by evidence reference
   */
  getRelationshipsByEvidenceRef(
    tenantId: string,
    evidenceRef: string
  ): Promise<RelationshipWithEvidence[]>;
}
