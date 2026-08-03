/**
 * Repository Layer
 *
 * Provides type-safe data access layer for PII/Non-PII separation.
 *
 * Architecture:
 * - Core Repositories: Non-PII data in D1_CORE
 * - PII Repositories: Personal information in D1_PII
 * - Base Repository: Common CRUD operations
 *
 * Usage:
 * ```typescript
 * import { CanonicalRuntimeUserStore, TombstoneRepository } from '@authrim/ar-lib-core/repositories';
 *
 * const userStore = new CanonicalRuntimeUserStore({ coreAdapter, piiAdapter, tenantId });
 * const user = await userStore.findById(userId);
 * ```
 */

// Base repository
export {
  BaseRepository,
  generateId,
  getCurrentTimestamp,
  type BaseEntity,
  type PaginationOptions,
  type PaginationResult,
  type FilterCondition,
  type FilterOperator,
  type RepositoryConfig,
} from './base';

// Core repositories (Non-PII)
// Note: User ID generation utilities (generateUserId, generateUserIdFromSettings, etc.)
// are exported from '../utils/id' via the main index.ts barrel export.
// They are NOT re-exported here to avoid ESM ambiguous star export conflicts.
export {
  PasskeyRepository,
  type CreatePasskeyInput,
  type UpdatePasskeyInput,
  type PasskeyFilterOptions,
  type AuthenticatorTransport,
  TotpCredentialRepository,
  type TotpCredential,
  type TotpCredentialStatus,
  type CreateTotpCredentialInput,
  type TotpBackupCode,
  type CreateTotpBackupCodeInput,
  ClientRepository,
  type OAuthClient,
  type CreateClientInput,
  type UpdateClientInput,
  type ClientFilterOptions,
  SessionRepository,
  type CreateSessionInput,
  type UpdateSessionInput,
  type SessionFilterOptions,
  RoleRepository,
  type UserRole,
  type CreateRoleInput,
  type UpdateRoleInput,
  SessionClientRepository,
  type SessionClient,
  type SessionClientWithDetails,
  type CreateSessionClientInput,
  type UpdateSessionClientInput,
  // Native SSO (OIDC Native SSO 1.0)
  DeviceSecretRepository,
  type CreateDeviceSecretResult,
  type DeviceSecretCreateOptions,
  DeviceInstallationRepository,
  type FindDeviceInstallationsOptions,
} from './core';

// PII repositories
export {
  TombstoneRepository,
  type Tombstone,
  type CreateTombstoneInput,
  type DeletionReason,
  SubjectIdentifierRepository,
  type SubjectIdentifier,
  type CreateSubjectIdentifierInput,
  LinkedIdentityRepository,
  type LinkedIdentity,
  type CreateLinkedIdentityInput,
  type UpdateLinkedIdentityInput,
  PIIAuditLogRepository,
  type PIIAuditLog,
  type PIIAuditAction,
  type CreatePIIAuditLogInput,
  type PIIAuditLogFilterOptions,
} from './pii';

// Cache repository
export {
  CacheRepository,
  createCacheRepository,
  DEFAULT_CACHE_CONFIG,
  CACHE_KEY_PREFIX,
  type CacheConfig,
  type CachedUserCore,
  type CachedClient,
  type CacheStats,
} from './cache';

// Canonical identity repositories (Unified Identity Mapping)
export {
  AttributeReleaseConsentRepository,
  CanonicalIdentityRepository,
  CanonicalRuntimeUserProjectionRepository,
  CanonicalRuntimeUserStore,
  CanonicalRuntimeUserWriter,
  CanonicalSensitiveValueResolver,
  decodeCanonicalSensitiveValueRef,
  encodeCanonicalSensitiveValueRef,
  findCanonicalAccountAuthenticationState,
  markOtpLoginEmailVerified,
  type AssuranceEvidenceRow,
  type AttributeClassification,
  type AttributeReleaseConsentRow,
  type AttributeReleaseConsentState,
  type AttributeValueType,
  type CanonicalIdentityGraph,
  type CanonicalAccountAuthenticationState,
  type CanonicalAuthenticationResponseUser,
  type CanonicalOtpLoginUser,
  type CanonicalRuntimeUserProjection,
  type CanonicalRuntimeUserProjectionOptions,
  type CanonicalRuntimeUserCreateInput,
  type CanonicalRuntimeUserStoreOptions,
  type CanonicalRuntimeUserWriteInput,
  type CanonicalRuntimeUserWriteResult,
  type CanonicalRuntimeValueResolver,
  type ContactPointRow,
  type ContactType,
  type ContactVerificationRow,
  type ContactVerificationState,
  type CreateAssuranceEvidenceInput,
  type CreateCanonicalIdentityGraphInput,
  type CreateContactPointInput,
  type CreateContactVerificationInput,
  type CreateIdentityAccountInput,
  type CreateIdentityBindingInput,
  type CreateIdentityResolutionCandidateInput,
  type CreateIdentitySubjectInput,
  type CreateProfileAttributeValueInput,
  type CreateProfileInput,
  type CreateStructuredAttributeValueInput,
  type CreateSubjectAccountLinkInput,
  type GrantAttributeReleaseConsentInput,
  type IdentityAccountRow,
  type IdentityAccountType,
  type IdentityBindingKind,
  type IdentityBindingRow,
  type IdentityLifecycleState,
  type IdentityResolutionCandidateRow,
  type IdentityResolutionCandidateState,
  type IdentityResolutionEventRow,
  type IdentityResolutionOutcome,
  type IdentitySubjectRow,
  type IdentitySubjectType,
  type JsonObject,
  type CanonicalSensitiveUserField,
  type CanonicalSensitiveValueRefInput,
  type ProfileAttributeValueRow,
  type ProfileRow,
  type ProfileType,
  type RecordIdentityResolutionEventInput,
  type StructuredAttributeValueRow,
  type SubjectAccountLinkRow,
  type SubjectAccountLinkType,
} from './identity';

// AI Grant repository (Human Auth / AI Ephemeral Auth Two-Layer Model)

// VC repositories (Phase 9)
export {
  TrustedIssuerRepository,
  type TrustedIssuerRecord,
  type CreateTrustedIssuerInput,
  type UpdateTrustedIssuerInput,
  type TrustedIssuerFilterOptions,
  type TrustLevel,
  type IssuerStatus,
  UserVerifiedAttributeRepository,
  type UserVerifiedAttribute,
  type CreateUserVerifiedAttributeInput,
  type UserVerifiedAttributeFilterOptions,
  type AttributeSourceType,
  AttributeVerificationRepository,
  type AttributeVerification,
  type CreateAttributeVerificationInput,
  type AttributeVerificationFilterOptions,
  type VerificationResultStatus,
  IssuedCredentialRepository,
  type IssuedCredentialRecord,
  type CreateIssuedCredentialInput,
  type UpdateIssuedCredentialInput,
  type IssuedCredentialFilterOptions,
  type CredentialStatus,
  DIDDocumentCacheRepository,
  type DIDDocumentCache,
  D1StatusListRepository,
} from './vc';

// Admin repositories (Admin/EndUser separation - DB_ADMIN)
export {
  // Core Admin Management
  AdminUserRepository,
  type AdminUserFilterOptions,
  AdminRoleRepository,
  AdminRoleAssignmentRepository,
  AdminSessionRepository,
  AdminPasskeyRepository,
  AdminAuditLogRepository,
  type AdminAuditLogFilterOptions,
  AdminIpAllowlistRepository,
  // Admin ABAC (Attribute-Based Access Control)
  AdminAttributeRepository,
  type AdminAttribute,
  type AdminAttributeCreateInput,
  AdminAttributeValueRepository,
  type AdminAttributeValue,
  type AdminAttributeValueCreateInput,
  // Admin ReBAC (Relationship-Based Access Control)
  AdminRelationshipRepository,
  type AdminRelationship,
  type AdminRelationshipCreateInput,
  AdminRebacDefinitionRepository,
  type AdminRebacDefinition,
  type AdminRebacDefinitionCreateInput,
  type AdminRebacDefinitionUpdateInput,
  // Admin Policies (Combined RBAC/ABAC/ReBAC)
  AdminPolicyRepository,
  type AdminPolicy,
  type AdminPolicyCreateInput,
  type AdminPolicyConditions,
  // Admin Machine Access
  AdminMachineAccessRepository,
  type AdminMachineActorRef,
  type AdminMachineClientCredential,
  type AdminMachineCredential,
  type AdminMachineCredentialAlgorithm,
  type AdminMachineCredentialCreateInput,
  type AdminMachineCredentialStatus,
  type AdminMachinePrincipal,
  type AdminMachinePrincipalCreateInput,
  type AdminMachinePrincipalStatus,
  type AdminMachinePrincipalType,
  type AdminMachineTenantScope,
  type AdminMachineTenantScopeMode,
} from './admin';

// Re-export database types for convenience
export type { DatabaseAdapter, ExecuteResult, PIIStatus, PIIClass } from '../db/adapter';
