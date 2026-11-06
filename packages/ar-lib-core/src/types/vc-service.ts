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

export interface VCIssuerServiceBinding {
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
