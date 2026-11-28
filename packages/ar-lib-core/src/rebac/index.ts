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
 * import { createReBACService, ReBACService } from '@authrim/ar-lib-core/rebac';
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
  CheckRequestContext,
  ContextualTuple,
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
  ReBACCheckOptions,
  ResolvedCheckRequest,
  // Group usersets
  SubjectGroupState,
  SubjectGroupsResolver,
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
  SubjectGroupsLookup,
  MembershipTrace,
  EvaluationResult,
  ActiveDefinition,
} from './interfaces';

// Group usersets
export {
  USERSET_GROUP_FROM_TYPE,
  USERSET_MEMBER_RELATION,
  expressionContainsExclusion,
  expressionContainsTupleToUserset,
} from './userset';
export { loadActiveDefinition } from './definitions';

// Service implementations
export {
  ReBACService,
  createReBACService,
  externalSubjectId,
  externalSubjectRef,
} from './rebac-service';

// Cache manager
export {
  ReBACCacheManager,
  RequestScopedCache,
  getReBACTenantVersion,
  bumpReBACTenantVersion,
} from './cache-manager';

// Closure manager
export { ClosureManager, createClosureManager } from './closure-manager';

// Relation parser
export {
  RelationParser,
  createEvaluationContext,
  parseObjectString,
  buildObjectString,
  relationDefinitionErrors,
} from './relation-parser';

// Tuple type rules (which tuples may be written)
export {
  ruleOnRelationshipTupleSource,
  relationshipSourceTypes,
  declaresTuplesetRelation,
  REBAC_SUBJECT_FROM_TYPE,
  REBAC_GROUP_FROM_TYPE,
} from './tuple-type-rules';
export type {
  RelationshipTupleSourceKind,
  RelationshipTupleSourceRuling,
  TupleTypeRuleStore,
} from './tuple-type-rules';
