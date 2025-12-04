// Re-export everything from shared modules
export * from './constants';
export * from './types/env';
export * from './types/oidc';
export * from './types/admin';
export * from './types/rbac';
export * from './types/consent';
export * from './types/saml';

// Utils
export * from './utils/audit-log';
export * from './utils/client-authentication';
export * from './utils/crypto';
export * from './utils/d1-retry';
export * from './utils/device-flow';
export * from './utils/ciba';
export * from './utils/dpop';
export * from './utils/errors';
export * from './utils/issuer';
export * from './utils/jwe';
export * from './utils/jwt';
export * from './utils/jwt-bearer';
export * from './utils/keys';
export * from './utils/kv';
export * from './utils/logger';
export * from './utils/origin-validator';
export * from './utils/pairwise';
export * from './utils/sd-jwt';
export * from './utils/session-state';
export * from './utils/tenant-context';
export * from './utils/token-introspection';
export * from './utils/validation';
export * from './utils/rbac-claims';
export * from './utils/policy-embedding';
export * from './utils/consent-rbac';

// Middleware
export * from './middleware/admin-auth';
export * from './middleware/rbac';
export * from './middleware/rate-limit';
export * from './middleware/initial-access-token';
export * from './middleware/request-context';
export * from './middleware/version-check';

// Storage
export * from './storage/interfaces';
export * from './storage/repositories';

// Durable Objects
export { KeyManager } from './durable-objects/KeyManager';
export { ChallengeStore } from './durable-objects/ChallengeStore';
export { DeviceCodeStore } from './durable-objects/DeviceCodeStore';
export { CIBARequestStore } from './durable-objects/CIBARequestStore';
export { VersionManager } from './durable-objects/VersionManager';
export { SAMLRequestStore } from './durable-objects/SAMLRequestStore';

// ReBAC (Relationship-Based Access Control)
export {
  // Service
  ReBACService,
  createReBACService,
  // Cache manager
  ReBACCacheManager,
  RequestScopedCache,
  // Closure manager
  ClosureManager,
  createClosureManager,
  // Relation parser
  RelationParser,
  createEvaluationContext,
  parseObjectString,
  buildObjectString,
  // Constants
  DEFAULT_CACHE_TTL,
  DEFAULT_MAX_DEPTH,
  REBAC_CACHE_PREFIX,
  DEFAULT_CLOSURE_BATCH_SIZE,
} from './rebac';

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
  RelationDefinition,
  // Cache types
  CheckCacheKey,
  CachedCheckResult,
  // Tuple types
  RelationshipTuple,
  ParsedObject,
  // Config
  ReBACConfig,
  // Interfaces
  IReBACService,
  IRelationDefinitionStore,
  IClosureManager,
  IReBACCacheManager,
  IRelationParser,
  RelationEvaluationContext,
} from './rebac';
