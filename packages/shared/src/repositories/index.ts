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
 * import {
 *   UserCoreRepository,
 *   UserPIIRepository,
 *   TombstoneRepository,
 * } from '@authrim/shared/repositories';
 *
 * // Core operations (Non-PII)
 * const userCoreRepo = new UserCoreRepository(coreAdapter);
 * const userCore = await userCoreRepo.findById(userId);
 *
 * // PII operations (requires PIIContext)
 * const piiAdapter = partitionRouter.getAdapterForPartition(userCore.pii_partition);
 * const userPIIRepo = new UserPIIRepository(piiAdapter);
 * const userPII = await userPIIRepo.findByUserId(userId);
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
export {
  UserCoreRepository,
  type UserCore,
  type CreateUserCoreInput,
  type UpdateUserCoreInput,
  type UserCoreFilterOptions,
  type CoreUserType,
  PasskeyRepository,
  type CreatePasskeyInput,
  type UpdatePasskeyInput,
  type PasskeyFilterOptions,
  type AuthenticatorTransport,
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
} from './core';

// PII repositories
export {
  UserPIIRepository,
  type UserPII,
  type CreateUserPIIInput,
  type UpdateUserPIIInput,
  type OIDCUserInfo,
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

// Re-export database types for convenience
export type { DatabaseAdapter, ExecuteResult, PIIStatus, PIIClass } from '../db/adapter';
