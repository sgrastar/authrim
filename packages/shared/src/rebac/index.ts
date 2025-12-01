/**
 * ReBAC (Relationship-Based Access Control) Module
 *
 * Phase 3 implementation of Zanzibar-lite access control:
 * - Check API: check(user, relation, object)
 * - List API: listObjects, listUsers
 * - Relation DSL: union, tuple-to-userset (MVP)
 * - Caching: KV + request-scoped
 *
 * Usage:
 * ```typescript
 * import { createReBACService, ReBACService } from '@authrim/shared/rebac';
 *
 * const rebac = createReBACService(adapter, { cache_ttl: 60 });
 *
 * const result = await rebac.check({
 *   tenant_id: 'tenant_123',
 *   user_id: 'user_456',
 *   relation: 'viewer',
 *   object: 'document:doc_789',
 * });
 * // { allowed: true, resolved_via: 'computed' }
 * ```
 */

// Types
export type {
  // Check API types
  CheckRequest,
  CheckResponse,
  BatchCheckRequest,
  BatchCheckResponse,
  CheckResolutionMethod,
  // List API types
  ListObjectsRequest,
  ListObjectsResponse,
  ListUsersRequest,
  ListUsersResponse,
  // Relation DSL types
  RelationExpression,
  DirectRelation,
  UnionRelation,
  TupleToUsersetRelation,
  IntersectionRelation,
  ExclusionRelation,
  RelationDefinition,
  RelationDefinitionRow,
  // Closure types
  ClosureEntry,
  ClosureEntryRow,
  // Cache types
  CheckCacheKey,
  CachedCheckResult,
  // Tuple types
  RelationshipTuple,
  ParsedObject,
  // Config
  ReBACConfig,
} from './types';

// Constants
export {
  DEFAULT_CACHE_TTL,
  DEFAULT_MAX_DEPTH,
  REBAC_CACHE_PREFIX,
  DEFAULT_CLOSURE_BATCH_SIZE,
} from './types';

// Interfaces
export type {
  IReBACService,
  IRelationDefinitionStore,
  IClosureManager,
  IReBACCacheManager,
  IRelationParser,
  IReBACServiceFactory,
  RelationEvaluationContext,
  RelationshipWithEvidence,
  IRelationshipStoreExtended,
} from './interfaces';

// Service implementations
export { ReBACService, createReBACService } from './rebac-service';

// Cache manager
export { ReBACCacheManager, RequestScopedCache } from './cache-manager';

// Closure manager
export { ClosureManager, createClosureManager } from './closure-manager';

// Relation parser
export {
  RelationParser,
  createEvaluationContext,
  parseObjectString,
  buildObjectString,
} from './relation-parser';
