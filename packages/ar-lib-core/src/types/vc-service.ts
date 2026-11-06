/**
 * Credential configuration issued only through the dedicated admin path. Credential Profiles must
 * never reference it.
 */
export const ADMIN_CREDENTIAL_CONFIGURATION_ID = 'AuthrimAdminCredential';

/** Least-privilege contract exposed by ar-vc to the Management Worker. */
export interface CreateCredentialOfferServiceInput {
  tenantId: string;
  userId: string;
  credentialProfileId: string;
  credentialProfileVersion: number;
  credentialProfileSnapshotHash: string;
  credentialProfileContractSignature: string;
  credentialConfigurationId: string;
  mappingVersionId: string;
  mappingSnapshotHash: string;
  claims: Record<string, unknown>;
  claimManifest: string[];
  credentialIssuer: string;
  expiresInSeconds?: number;
  transactionCodeRequired?: boolean;
}

export interface CreateCredentialOfferServiceResult {
  offerId: string;
  /** https URI of the Credential Offer object (`credential_offer_uri`). */
  credentialOfferUri: string;
  /** `openid-credential-offer://?credential_offer_uri=...`, the value to render as a QR code. */
  credentialOffer: string;
  expiresAt: number;
  claimManifestHash: string;
  transactionCode?: string;
}

/** Offer of the admin credential for an administrator's own wallet (design D4). */
export interface CreateAdminCredentialOfferServiceInput {
  /** The admin's home tenant (`admin_users.tenant_id`). */
  tenantId: string;
  adminUserId: string;
  /** https origin of the home tenant: the Credential Issuer. */
  credentialIssuer: string;
}

export interface CreateAdminCredentialOfferServiceResult {
  offerId: string;
  credentialOfferUri: string;
  credentialOffer: string;
  expiresAt: number;
  /** Always present: admin offers require a transaction code. */
  transactionCode: string;
}

/**
 * Progress of an admin credential offer, for the console's polling (design D5).
 * - `pending`: not fetched by any wallet yet
 * - `fetched`: a wallet resolved the offer URI; the console may now show the transaction code
 * - `token_issued`: the pre-authorized code was exchanged
 * - `issued`: the credential was signed and returned; `holderKeyThumbprint` is set
 * - `failed`: issuance started and did not complete; a new offer is needed
 * - `expired` / `locked`: unusable
 */
export type AdminCredentialOfferState =
  | 'pending'
  | 'fetched'
  | 'token_issued'
  | 'issued'
  | 'failed'
  | 'expired'
  | 'locked';

export interface AdminCredentialOfferStatus {
  offerId: string;
  state: AdminCredentialOfferState;
  expiresAt: number;
  /** RFC 7638 thumbprint of the issued credential's `cnf.jwk` (base64url), once issued. */
  holderKeyThumbprint?: string;
}

/** Why an administrator presentation is asked for. */
export type AdminPresentationPurpose = 'step_up' | 'enroll';

export interface CreateAdminPresentationInput {
  /** The admin's home tenant (issuer of the admin credential). */
  tenantId: string;
  adminUserId: string;
  /** The admin session the result may be recorded on; nothing else can consume it. */
  sessionId: string;
  purpose: AdminPresentationPurpose;
  /**
   * step_up: RFC 7638 thumbprints of the admin's active Keyring second factors (one must be
   * presented). enroll: the ones already registered (none of them may be presented).
   */
  holderJkts: string[];
  /** The tenant's canonical https base URL (credential issuer and verifier). */
  credentialIssuer: string;
  /** Tenant name shown in the wallet. */
  tenantLabel: string;
  /** Opaque to ar-vc, returned with the result (string values, at most 2 KiB as JSON). */
  context?: Record<string, string | null>;
}

export interface CreateAdminPresentationResult {
  requestId: string;
  /** `openid4vp://` value for the QR code. */
  qr: string;
  /** The two digits the console shows and the admin types into the wallet. */
  matchCode: string;
  expiresAt: number;
}

export type AdminPresentationStatus =
  | 'pending'
  | 'processing'
  | 'verified'
  | 'failed'
  | 'expired'
  | 'consumed';

export interface AdminPresentationRef {
  tenantId: string;
  adminUserId: string;
  sessionId: string;
  requestId: string;
}

export interface AdminPresentationResult {
  purpose: AdminPresentationPurpose;
  context: Record<string, string | null>;
  /** RFC 7638 thumbprint of the presented holder key. */
  holderJkt: string;
  /** The admin credential's public id. */
  credentialId: string;
  verifiedAt: number;
}

export interface VCIssuerServiceBinding {
  /** Start an administrator presentation (QR, cross-device). */
  createAdminPresentationRequest(
    input: CreateAdminPresentationInput
  ): Promise<CreateAdminPresentationResult>;
  /** Null when the request does not exist or belongs to another admin session. */
  getAdminPresentationStatus(
    input: AdminPresentationRef
  ): Promise<{ status: AdminPresentationStatus; expiresAt: number; errorCode?: string } | null>;
  /** The verified result, handed over once; null otherwise. */
  consumeAdminPresentation(input: AdminPresentationRef): Promise<AdminPresentationResult | null>;

  createCredentialOffer(
    input: CreateCredentialOfferServiceInput
  ): Promise<CreateCredentialOfferServiceResult>;
  createAdminCredentialOffer(
    input: CreateAdminCredentialOfferServiceInput
  ): Promise<CreateAdminCredentialOfferServiceResult>;
  /** Null when the offer does not exist or belongs to another admin or tenant. */
  getAdminCredentialOfferStatus(input: {
    tenantId: string;
    adminUserId: string;
    offerId: string;
  }): Promise<AdminCredentialOfferStatus | null>;
}

/** ar-vc → ar-management: issuance-time re-check of an admin's eligibility (design D4). */
export interface AdminCredentialEligibilityServiceBinding {
  checkAdminCredentialEligibility(input: {
    tenantId: string;
    adminUserId: string;
  }): Promise<{ eligible: boolean; email?: string; name?: string | null }>;
}
