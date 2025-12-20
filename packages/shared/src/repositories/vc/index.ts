/**
 * VC (Verifiable Credentials) Repositories
 *
 * Repositories for Phase 9 VC/DID support.
 *
 * Note: Entity types use "Record" suffix to avoid conflicts with domain types
 * (e.g., TrustedIssuerRecord vs TrustedIssuer from jwt-bearer.ts)
 */

export { TrustedIssuerRepository } from './trusted-issuer';
export type {
  TrustedIssuer as TrustedIssuerRecord,
  CreateTrustedIssuerInput,
  UpdateTrustedIssuerInput,
  TrustedIssuerFilterOptions,
  TrustLevel,
  IssuerStatus,
} from './trusted-issuer';

export { UserVerifiedAttributeRepository } from './user-verified-attribute';
export type {
  UserVerifiedAttribute,
  CreateUserVerifiedAttributeInput,
  UserVerifiedAttributeFilterOptions,
  AttributeSourceType,
} from './user-verified-attribute';

export { AttributeVerificationRepository } from './attribute-verification';
export type {
  AttributeVerification,
  CreateAttributeVerificationInput,
  AttributeVerificationFilterOptions,
  VerificationResultStatus,
} from './attribute-verification';

export { IssuedCredentialRepository } from './issued-credential';
export type {
  IssuedCredential as IssuedCredentialRecord,
  CreateIssuedCredentialInput,
  UpdateIssuedCredentialInput,
  IssuedCredentialFilterOptions,
  CredentialStatus,
} from './issued-credential';

export { DIDDocumentCacheRepository } from './did-document-cache';
export type { DIDDocumentCache } from './did-document-cache';

export { D1StatusListRepository } from './status-list';
