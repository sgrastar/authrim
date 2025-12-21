// Re-export everything from shared modules
export * from './constants';
export * from './types/env';
export * from './types/oidc';
export * from './types/admin';
export * from './types/rbac';
export * from './types/consent';
export * from './types/saml';
export * from './types/policy-rules';
export * from './types/jit-config';
export * from './types/token-claim-rules';
export * from './types/check-api';

// Phase 9: VC/DID Types
export * from './types/did';
export * from './types/openid4vp';
export * from './types/openid4vci';

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
export * from './utils/ec-keys';
export * from './utils/session-state';
export * from './utils/session-helper';
export * from './utils/authcode-helper';
export * from './utils/tenant-context';
export * from './utils/token-introspection';
export * from './utils/validation';
export * from './utils/logout-validation';
export * from './utils/rbac-claims';
export * from './utils/policy-embedding';
export * from './utils/resource-permissions';
export * from './utils/consent-rbac';
export * from './utils/refresh-token-sharding';
export * from './utils/oauth-config';
export * from './utils/challenge-sharding';
export * from './utils/token-revocation-sharding';
export * from './utils/region-sharding';
export * from './utils/dpop-jti-sharding';
export * from './utils/par-sharding';
export * from './utils/device-code-sharding';
export * from './utils/ciba-sharding';
export * from './utils/do-retry';
export * from './utils/url-security';
export * from './utils/email-domain-hash';
export * from './utils/claim-normalizer';
export * from './utils/feature-flags';

// Phase 9: VC (Verifiable Credentials)
export * from './vc/haip-policy';
export * from './vc/sd-jwt-vc';
export * from './vc/status-list';
export * from './vc/status-list-manager';

// Services
export * from './services/rule-evaluator';
export * from './services/org-domain-resolver';
export * from './services/token-claim-evaluator';
export * from './services/unified-check-service';
export * from './services/permission-change-notifier';

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

// Database Adapters (PII/Non-PII separation)
export * from './db';

// Repositories (PII/Non-PII separation)
export * from './repositories';

// Context (PII/Non-PII separation)
export * from './context';

// Actor abstraction (platform-agnostic DO interfaces)
export type { ActorContext } from './actor';
export type { ActorStorage, StoragePutOptions, StorageListOptions } from './actor';
export { CloudflareActorContext } from './actor';

// Durable Objects
export { KeyManager } from './durable-objects/KeyManager';
export { ChallengeStore } from './durable-objects/ChallengeStore';
export type {
  ChallengeType,
  Challenge,
  StoreChallengeRequest,
  ConsumeChallengeRequest,
  ConsumeChallengeResponse,
} from './durable-objects/ChallengeStore';
export { DeviceCodeStore } from './durable-objects/DeviceCodeStore';
export { CIBARequestStore } from './durable-objects/CIBARequestStore';
export { VersionManager } from './durable-objects/VersionManager';
export { SAMLRequestStore } from './durable-objects/SAMLRequestStore';
export { SessionStore } from './durable-objects/SessionStore';
export type { Session, SessionData, SessionResponse } from './durable-objects/SessionStore';
export { AuthorizationCodeStore } from './durable-objects/AuthorizationCodeStore';
export { RefreshTokenRotator } from './durable-objects/RefreshTokenRotator';
export { RateLimiterCounter } from './durable-objects/RateLimiterCounter';
export { PARRequestStore } from './durable-objects/PARRequestStore';
export type { PARRequestData } from './durable-objects/PARRequestStore';
export { PermissionChangeHub } from './durable-objects/PermissionChangeHub';

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
