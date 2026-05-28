// Re-export everything from shared modules
export * from './constants';
export * from './types/env';
export * from './types/oidc';
export * from './types/admin';
export * from './types/admin-user';
export * from './types/rbac';
export * from './types/consent';
export * from './types/saml';
export * from './types/dr-bundle';
export * from './types/policy-rules';
export * from './types/jit-config';
export * from './types/token-claim-rules';
export * from './types/check-api';
export * from './types/support-ops';
export * from './types/runtime-profile';
export * from './types/approval';

// RFC 7517: JWK Types
export * from './types/jwk';

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

// Flow UI Types (Flow × UI Separation Architecture)
export * from './schemas/flow-ui';

// API Versioning Types (Stripe-style date-based versioning)
export * from './types/api-version';

// Deprecation Types (RFC 8594 Sunset Header)
export * from './types/deprecation';

// SDK Compatibility Types (preparation for future SDK)
export * from './types/sdk-compatibility';

// ID-JAG (Identity Assertion Authorization Grant) Types
export * from './types/id-jag';

// Assurance Levels Types (NIST SP 800-63-4)
export * from './types/settings/assurance-levels';

// Utils
export * from './utils/audit-log';
export * from './utils/client-authentication';
export * from './utils/crypto';
export * from './utils/id';
export * from './utils/d1-retry';
export * from './utils/device-flow';
export * from './utils/ciba';
export * from './utils/delegated-write';
export * from './utils/dpop';
export * from './utils/dr-bundle';
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
export * from './utils/tenant-request-policy';
export * from './utils/tenant-binding-policy';
export * from './utils/token-introspection';
export * from './utils/validation';
export * from './utils/logout-validation';
export * from './utils/rbac-claims';
export * from './utils/policy-embedding';
export * from './utils/resource-permissions';
export * from './utils/consent-rbac';
export * from './utils/refresh-token-sharding';
export * from './utils/refresh-token-store';
export * from './utils/oauth-config';
export * from './utils/oidc-claims';
export * from './utils/canonical-runtime-claims';
export * from './utils/dcr-config';
export * from './utils/encryption-config';
export * from './utils/settings-manager';
export * from './utils/pii-encryption';
export * from './utils/pii-config';
export * from './utils/challenge-sharding';
export * from './utils/token-revocation-sharding';
export * from './utils/region-sharding';
export * from './utils/dpop-jti-sharding';
export * from './utils/par-sharding';
export * from './utils/saml-request-store';
export * from './utils/device-code-sharding';
export * from './utils/ciba-sharding';
export * from './utils/flow-state-sharding';
export * from './utils/do-retry';
export * from './utils/url-security';
export * from './utils/body-limits';
export * from './utils/basic-auth';
export * from './utils/web-origin-registry';
export * from './utils/jwks-cache';
export * from './utils/tenant-settings';
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
export * from './utils/native-sso-installation';

// Consent Versioning (GDPR Article 7 - Informed Consent)
export * from './utils/consent-versioning';

// Consent Statements (SAP CDC-like Consent Management)
export type {
  ConsentStatement,
  ConsentStatementVersion,
  ConsentStatementLocalization,
  ConsentStatementUserRecord,
  TenantConsentRequirement,
  ClientConsentOverride,
  ConsentScreenItem,
  ConsentItemDecision,
  ConsentEvidence,
  ResolvedConsentRequirement,
  ConsentItemHistoryRecord,
  CreateConsentStatementInput,
  UpdateConsentStatementInput,
  CreateConsentVersionInput,
  UpdateConsentVersionInput,
  UpsertLocalizationInput,
  SetTenantRequirementInput,
  SetClientOverrideInput,
  ConditionalConsentRule,
  ConsentItemEventData,
  ConsentItemVersionUpgradedEventData,
} from './types/consent-statements';
export {
  ConsentCategory,
  LegalBasis,
  ConsentEnforcement,
  ClientConsentRequirement,
  ConsentContentType,
  ConsentVersionStatus,
  ConsentRecordStatus,
  ConsentItemAction,
  ConditionalRuleOperator,
} from './types/consent-statements';
export * from './utils/consent-statements';

// Initial Setup (Admin Account Setup)
export * from './utils/setup-token';
export * from './utils/setup-session';
export * from './utils/system-init';
export * from './utils/contract-loader';
export * from './utils/cache-config';
export * from './utils/request-cache';
export * from './utils/health-check';
export * from './utils/dns-verification';
export * from './utils/security';
export * from './utils/cookie-config';

// Settings History (Configuration Rollback)
export * from './services/settings-history';
export * from './services/auth-core-persistence-context';
export * from './services/consent-store';
export * from './services/refresh-token-family-index';
export * from './services/object-artifact-crypto';
export * from './services/object-artifact-store';
export * from './services/object-catalog';
export * from './services/sensitive-detail-chunk-store';
export * from './services/identity-identifier-bridge';
export * from './services/identity-resolution';
export * from './services/identity-release-consent';
export * from './services/logging-runtime-policy';
export * from './services/logging-runtime-emitter';
export * from './services/pii-compensation-policy';
export * from './services/pii-write-compensation';
export * from './services/storage-boundary-policy';
export * from './services/storage-profile-capabilities';
export * from './services/storage-profile-health';
export * from './services/approval-governance';
export * from './services/step-up';
export * from './services/downstream-elevation-grant';
export * from './services/downstream-elevation-grant-client';
export * from './services/downstream-grant-protected-resource';
export * from './services/downstream-grant-protected-resource-client';
export * from './services/downstream-grant-protected-resource-redaction';
export * from './services/product-protected-resources';
export * from './services/admin-role-templates';
export * from './services/logout-device-secret-revocation';

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
  PHASE1_ERROR_DETAIL_CODES,
  PHASE1_ERROR_DETAIL_DEFINITIONS,
  getPhase1ErrorDetailDefinition,
  createPhase1ErrorDetails,
  type RFCErrorCode,
  type ARErrorCode,
  type Phase1ErrorDetailCode,
  type NativeSSOErrorDetailCode,
  type DeviceSecretPolicyErrorDetailCode,
  type CompatibilityErrorDetailCode,
  type Phase1ErrorDetailDefinition,
  type Phase1ErrorDetailDefinitions,
  type Phase1ErrorDetails,
  type Phase1ErrorDetailsOverrides,
  type Phase1ErrorDetailSeverity,
  type Phase1ErrorDetailUserAction,
  createStepUpErrorBody,
  createStepUpErrorResponse,
  type CreateStepUpErrorBodyInput,
  type StepUpActionStatus,
  type StepUpErrorDetailCode,
  type StepUpErrorResponseBody,
  type StepUpInputState,
  type StepUpPreferredMethod,
  type StepUpStatusObject,
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
export * from './services/tenant-domain-resolver';
export * from './services/tenant-vanity-domain-resolver';
export * from './services/token-claim-evaluator';
export * from './services/unified-check-service';
export * from './services/support-ops';
export * from './services/check-audit-service';
export * from './services/permission-change-notifier';
export * from './services/admin-database-adapter';
export * from './services/backchannel-logout-sender';
export * from './services/frontchannel-logout';
export * from './services/logout-webhook-sender';
export * from './services/invitation-auth-core';
export * from './services/policy-resolver';
export * from './services/custom-claims';
export * from './services/custom-claim-schema-history';
export * from './services/profile-registry';
export * from './services/runtime-profile-resolver';
export * from './services/session-client-store';
export * from './services/storage-target-resolver';
export * from './services/tenant-database-health';
export * from './services/tenant-backup-policy';
export * from './services/tenant-database-naming';
export * from './services/tenant-database-registry-factory';
export * from './services/tenant-database-registry-signature';
export * from './services/tenant-database-reconciliation';
export * from './services/tenant-database-migration-validation';
export * from './services/tenant-database-resolver';
export * from './services/tenant-database-sharding-policy';
export * from './services/tenant-database-stats';
export * from './services/tenant-runtime-config-snapshot';
export * from './services/tenant-runtime-registry-security-events';
export * from './services/tenant-runtime-registry-snapshot';
export * from './services/user-store-runtime-sources';
export * from './services/refresh-token-family-store';

// Repositories
export * from './repositories/admin';

// Audit Logging (Phase 10 - Unified Audit System)
export * from './services/audit';
export {
  createAuditPrimaryDatabaseAdapter,
  createAuditPrimaryStorageAdapter,
  createExternalAuditDatabaseAdapter,
  createExternalAuditStorageAdapter,
} from './services/audit';

// Diagnostic Logging (Debugging, Troubleshooting, OIDF Conformance)
export * from './services/diagnostic';
export * from './utils/diagnostic-security';
export * from './utils/diagnostic-log-formatter';

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
export * from './middleware/api-version';
export * from './middleware/deprecation-headers';
export * from './middleware/sdk-compatibility';
export * from './middleware/idempotency';
export * from './middleware/diagnostic-logging-middleware';
export * from './middleware/csrf';

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
export { SAMLAggregateMetadataStore } from './durable-objects/SAMLAggregateMetadataStore';
export { SessionStore } from './durable-objects/SessionStore';
export type { Session, SessionData, SessionResponse } from './durable-objects/SessionStore';
export { AuthorizationCodeStore } from './durable-objects/AuthorizationCodeStore';
export { RefreshTokenRotator } from './durable-objects/RefreshTokenRotator';
export { RateLimiterCounter } from './durable-objects/RateLimiterCounter';
export { PARRequestStore } from './durable-objects/PARRequestStore';
export type { PARRequestData } from './durable-objects/PARRequestStore';
export { PermissionChangeHub } from './durable-objects/PermissionChangeHub';
export { FlowStateStore } from './durable-objects/FlowStateStore';
export { DEFAULT_FLOW_TTL_MS, MAX_PROCESSED_REQUEST_IDS } from './durable-objects/FlowStateStore';
export type {
  RuntimeState,
  RuntimeStateSnapshot,
  FlowSubmitResult,
  CreateRuntimeStateParams,
  OAuthFlowParams as FlowOAuthParams,
} from './durable-objects/FlowStateStore';

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
