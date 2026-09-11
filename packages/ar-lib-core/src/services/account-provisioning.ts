import type {
  CanonicalRuntimeUserWriteInput,
  CanonicalSensitiveUserField,
} from '../repositories/identity';

export type AuthAccountProvisioningFlow =
  | 'email_code'
  | 'passkey'
  | 'totp'
  | 'directory_password'
  | 'external_idp'
  | 'saml'
  | 'did'
  | 'test_stub'
  | 'guest'
  | 'guest_upgrade';

export interface AuthGuestResumeCredentialProvisioningInput {
  id: string;
  credentialHash: string;
  expiresInDays: number | null;
  guestLifecycle?: {
    clientId: string;
    deletionAfterDays: number | null;
    policyVersion: string;
  };
}

export interface AuthExternalIdpIdentityProvisioningInput {
  id: string;
  providerId: string;
  providerUserId: string;
  providerEmail: string | null;
  emailVerified: boolean;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
  tokenExpiresAt: number | null;
  rawClaimsJson: string;
  profileDataEncrypted: string;
}

export interface AuthAccountProvisioningInput {
  schemaVersion: 1;
  operationId: string;
  idempotencyKey: string;
  tenantId: string;
  candidateUserId: string;
  flow: AuthAccountProvisioningFlow;
  email: string | null;
  externalSubject?: { issuer: string; subject: string } | null;
  guestResumeCredential?: AuthGuestResumeCredentialProvisioningInput | null;
  externalIdentity?: AuthExternalIdpIdentityProvisioningInput | null;
  runtimeUser: Omit<CanonicalRuntimeUserWriteInput, 'userId' | 'tenantId'> & {
    piiFields?: Partial<Record<CanonicalSensitiveUserField, boolean>>;
    sensitiveValues?: Partial<Record<CanonicalSensitiveUserField, unknown>>;
  };
}

export interface AuthAccountProvisioningResult {
  status: 201 | 202;
  operationId: string;
  accountId: string;
  userId: string;
}

export interface AuthAccountProvisioningStatusInput {
  schemaVersion: 1;
  tenantId: string;
  operationId: string;
  flow: AuthAccountProvisioningFlow;
}

export interface AuthAccountProvisioningStatusResult {
  status: 'pending' | 'ready' | 'failed';
  operationId: string;
  accountId: string;
  userId: string;
}

export interface AuthPasskeyRoutePublicationInput {
  schemaVersion: 1;
  operationId: string;
  idempotencyKey: string;
  tenantId: string;
  accountId: string;
  userId: string;
  passkeyId: string;
  credentialId: string;
  rpId: string;
}

export interface AuthPasskeyRoutePublicationResult {
  status: 201 | 202;
  operationId: string;
  accountId: string;
}

export interface AuthDirectoryRoutePublicationInput {
  schemaVersion: 1;
  operationId: string;
  idempotencyKey: string;
  tenantId: string;
  accountId: string;
  userId: string;
  connectorId: string;
  directorySubject: string;
}

export type AuthDirectoryRoutePublicationResult = AuthPasskeyRoutePublicationResult;

export interface ExternalIdpRoutePublicationInput {
  schemaVersion: 1;
  operationId: string;
  idempotencyKey: string;
  tenantId: string;
  accountId: string;
  userId: string;
  linkedIdentityId: string;
  providerId: string;
  providerUserId: string;
}

export type ExternalIdpRoutePublicationResult = AuthPasskeyRoutePublicationResult;

export type ExternalIdpRouteRemovalInput = ExternalIdpRoutePublicationInput;
export type ExternalIdpRouteRemovalResult = AuthPasskeyRoutePublicationResult;

export interface ExternalIdpRouteRemovalStatusInput {
  schemaVersion: 1;
  tenantId: string;
  accountId: string;
  userId: string;
  operationId: string;
}

export interface ExternalIdpPiiSourceShardListInput {
  schemaVersion: 1;
  afterShardId: string | null;
  limit: number;
}

export interface ExternalIdpPiiSourceShard {
  shardId: string;
  bindingRef: string;
  residencyPartition: string;
  routeGeneration: number;
}

const PASSKEY_CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,2048}$/u;
const PASSKEY_RP_ID =
  /^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*)$/u;

export function passkeyCredentialLookupSubject(input: { rpId: string; credentialId: string }): {
  issuer: string;
  subject: string;
} {
  const rpId = input.rpId.trim().toLowerCase().replace(/\.$/u, '');
  if (!PASSKEY_RP_ID.test(rpId) || rpId.length > 253) {
    throw new Error('passkey_route_rp_id_invalid');
  }
  if (!PASSKEY_CREDENTIAL_ID.test(input.credentialId)) {
    throw new Error('passkey_route_credential_id_invalid');
  }
  return {
    issuer: `urn:authrim:passkey:${rpId}`,
    subject: input.credentialId,
  };
}

export function guestResumeCredentialLookupSubject(credentialHash: string): {
  issuer: string;
  subject: string;
} {
  if (!/^[a-f0-9]{64}$/u.test(credentialHash)) {
    throw new Error('guest_resume_credential_digest_invalid');
  }
  return {
    issuer: 'urn:authrim:guest-resume:v1',
    subject: credentialHash,
  };
}

export function directoryIdentityLookupSubject(input: {
  connectorId: string;
  directorySubject: string;
}): { issuer: string; subject: string } {
  const connectorId = input.connectorId.trim();
  const directorySubject = input.directorySubject.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(connectorId)) {
    throw new Error('directory_route_connector_id_invalid');
  }
  if (!directorySubject || directorySubject.length > 2048) {
    throw new Error('directory_route_subject_invalid');
  }
  return { issuer: `urn:authrim:directory:${connectorId}`, subject: directorySubject };
}

export interface AuthAccountProvisioningServiceBinding {
  provisionAuthAccount(input: AuthAccountProvisioningInput): Promise<AuthAccountProvisioningResult>;
  getAuthAccountProvisioningStatus(
    input: AuthAccountProvisioningStatusInput
  ): Promise<AuthAccountProvisioningStatusResult>;
  publishAuthPasskeyRoute(
    input: AuthPasskeyRoutePublicationInput
  ): Promise<AuthPasskeyRoutePublicationResult>;
  publishAuthDirectoryRoute(
    input: AuthDirectoryRoutePublicationInput
  ): Promise<AuthDirectoryRoutePublicationResult>;
}

export interface ExternalIdpAccountProvisioningServiceBinding {
  provisionExternalIdpAccount(
    input: AuthAccountProvisioningInput
  ): Promise<AuthAccountProvisioningResult>;
  getExternalIdpAccountProvisioningStatus(
    input: AuthAccountProvisioningStatusInput
  ): Promise<AuthAccountProvisioningStatusResult>;
  publishExternalIdpRoute(
    input: ExternalIdpRoutePublicationInput
  ): Promise<ExternalIdpRoutePublicationResult>;
  removeExternalIdpRoute(
    input: ExternalIdpRouteRemovalInput
  ): Promise<ExternalIdpRouteRemovalResult>;
  getExternalIdpRouteRemovalStatus(
    input: ExternalIdpRouteRemovalStatusInput
  ): Promise<ExternalIdpRouteRemovalResult>;
  listExternalIdpPiiSourceShards(
    input: ExternalIdpPiiSourceShardListInput
  ): Promise<ExternalIdpPiiSourceShard[]>;
}
