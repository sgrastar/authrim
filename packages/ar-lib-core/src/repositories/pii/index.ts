/**
 * PII Repositories
 *
 * Repositories for data stored in D1_PII database.
 * Contains personal information separated from Core DB.
 *
 * Included repositories:
 * - TombstoneRepository: GDPR deletion tracking
 * - SubjectIdentifierRepository: Pairwise subject identifiers
 * - LinkedIdentityRepository: External IdP linked identities
 * - PIIAuditLogRepository: PII access audit log
 */

export {
  TombstoneRepository,
  type Tombstone,
  type CreateTombstoneInput,
  type DeletionReason,
} from './tombstone';

export {
  SubjectIdentifierRepository,
  type SubjectIdentifier,
  type CreateSubjectIdentifierInput,
} from './subject-identifier';

export {
  LinkedIdentityRepository,
  type LinkedIdentity,
  type CreateLinkedIdentityInput,
  type UpdateLinkedIdentityInput,
} from './linked-identity';

export {
  PIIAuditLogRepository,
  type PIIAuditLog,
  type PIIAuditAction,
  type CreatePIIAuditLogInput,
  type PIIAuditLogFilterOptions,
} from './audit-log';
