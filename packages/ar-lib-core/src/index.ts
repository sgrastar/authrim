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

// Phase A-6: Logout Types
export * from './types/logout';

// Settings Types (Settings API v2)
export * from './types/settings';

// Contract Types (Three-Layer Policy Hierarchy)
export * from './types/contracts';

// API Versioning Types (Stripe-style date-based versioning)
export * from './types/api-version';

// Deprecation Types (RFC 8594 Sunset Header)
export * from './types/deprecation';

// SDK Compatibility Types (preparation for future SDK)
export * from './types/sdk-compatibility';

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
export * from './utils/encryption-config';
export * from './utils/settings-manager';
export * from './utils/pii-encryption';
export * from './utils/challenge-sharding';
export * from './utils/token-revocation-sharding';
export * from './utils/region-sharding';
export * from './utils/dpop-jti-sharding';
export * from './utils/par-sharding';
export * from './utils/device-code-sharding';
export * from './utils/ciba-sharding';
export * from './utils/do-retry';
export * from './utils/url-security';
export * from './utils/basic-auth';
export * from './utils/jwks-cache';
export * from './utils/email-domain-hash';
export * from './utils/claim-normalizer';
export * from './utils/feature-flags';
export * from './utils/device-fingerprint';
export * from './utils/ssrf-protection';
export * from './utils/ui-config';
export * from './utils/conformance-config';
export * from './utils/custom-redirect';
export * from './utils/ui-url-validator';
export * from './utils/api-version-config';
export * from './utils/deprecation-config';
export * from './utils/sdk-compatibility-config';

// RFC 9396: Rich Authorization Requests (RAR)
export * from './utils/rar-validation';

// Native SSO (OIDC Native SSO 1.0)
export * from './utils/native-sso-config';

// Consent Versioning (GDPR Article 7 - Informed Consent)
export * from './utils/consent-versioning';

// Initial Setup (Admin Account Setup)
export * from './utils/setup-token';
export * from './utils/setup-session';
export * from './utils/system-init';
export * from './utils/contract-loader';
export * from './utils/health-check';
export * from './utils/dns-verification';

// Settings History (Configuration Rollback)
export * from './services/settings-history';

// Error System (Phase 10 - SDK public types)
// Note: Exported with namespace to avoid conflicts with legacy error types
// Types are also re-exported individually for convenience
export * as errors from './errors';
export type {
  ErrorDescriptor,
  ErrorMeta,
  UserAction,
  Severity,
  ErrorLocale,
  ErrorIdMode,
  ErrorResponseFormat,
  ErrorSecurityLevel,
  ErrorCodeDefinition,
  ErrorFactoryOptions,
  SerializeOptions,
  ProblemDetailsResponse,
} from './errors';
export { SECURITY_TRACKED_ERRORS, OIDC_CORE_ENDPOINTS } from './errors';
export {
  AR_ERROR_CODES,
  RFC_ERROR_CODES,
  ERROR_DEFINITIONS,
  type RFCErrorCode,
  type ARErrorCode,
} from './errors';
export { configureFactory, createError, createRFCError, Errors } from './errors';
export {
  serializeError,
  serializeToOAuth,
  serializeToProblemDetails,
  serializeToRedirect,
} from './errors';
export { errorResponse, redirectErrorResponse, determineFormat, createSerializer } from './errors';
export {
  AuthrimError,
  RFCError,
  errorMiddleware,
  createErrorFactoryFromContext,
  createErrorResponse,
  createRFCErrorResponse,
} from './errors';

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
export * from './services/backchannel-logout-sender';
export * from './services/frontchannel-logout';
export * from './services/logout-webhook-sender';
export * from './services/policy-resolver';

// Event System (Unified Event System)
// Note: types/events exports are namespaced to avoid conflicts with types/contracts
export * as Events from './types/events';
// Re-export commonly needed types directly for convenience
export type {
  UnifiedEvent,
  EventPublishPayload,
  EventPublishOptions,
  EventPublishResult as EventResult,
  EventDispatcher,
  EventHandlerConfig,
  EventHandlerRegistry,
  EventHookRegistry,
  BeforeHookConfig,
  AfterHookConfig,
  CreateWebhookInput,
  UpdateWebhookInput,
  WebhookConfig,
  // Event data types for type-safe event publishing
  AuthEventData,
  SessionEventData,
  TokenEventData,
  BatchRevokeEventData,
  ConsentEventData,
  ExtendedConsentEventData,
  UserEventData,
  ClientEventData,
  SecurityEventData,
  DomainEventData,
  SettingsEventData,
} from './types/events';
export {
  createUnifiedEvent,
  matchEventPattern,
  // Event type constants for easy access
  AUTH_EVENTS,
  SESSION_EVENTS,
  TOKEN_EVENTS,
  CONSENT_EVENTS,
  USER_EVENTS,
  CLIENT_EVENTS,
  SECURITY_EVENTS,
  DOMAIN_EVENTS,
  SETTINGS_EVENTS,
  EVENT_TYPES,
} from './types/events';
export * from './services/event-handler-registry';
export * from './services/event-hook-registry';
export * from './services/webhook-registry';
export * from './services/event-dispatcher';
// Note: webhook-sender exports are namespaced to avoid conflicts with logout-webhook-sender
export * as WebhookSender from './services/webhook-sender';
// Event dispatcher factory for easy use in handlers
export * from './utils/event-dispatcher-factory';

// Middleware
export * from './middleware/admin-auth';
export * from './middleware/rbac';
export * from './middleware/rate-limit';
export * from './middleware/initial-access-token';
export * from './middleware/request-context';
export * from './middleware/version-check';
export * from './middleware/api-version';
export * from './middleware/deprecation-headers';
export * from './middleware/sdk-compatibility';

// Plugin Context (Phase 9 - Plugin Architecture)
export * from './middleware/plugin-context';

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
