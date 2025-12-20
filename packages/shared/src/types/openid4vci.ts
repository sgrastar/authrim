/**
 * OpenID4VCI (OpenID for Verifiable Credential Issuance) Types
 *
 * Type definitions for OpenID4VCI 1.0 Final (September 2025)
 * Implements the Issuer role for issuing VCs to digital wallets.
 *
 * @see https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html
 */

import type { HaipCredentialFormat, HaipSignatureAlgorithm } from '../vc/haip-policy';

// =============================================================================
// Issuer Metadata
// =============================================================================

/**
 * Credential Issuer Metadata
 * Published at /.well-known/openid-credential-issuer
 */
export interface CredentialIssuerMetadata {
  /** Credential issuer identifier (URL) */
  credential_issuer: string;

  /** Authorization server metadata URL (if different) */
  authorization_servers?: string[];

  /** Credential endpoint */
  credential_endpoint: string;

  /** Batch credential endpoint */
  batch_credential_endpoint?: string;

  /** Deferred credential endpoint */
  deferred_credential_endpoint?: string;

  /** Notification endpoint */
  notification_endpoint?: string;

  /** Credential response encryption */
  credential_response_encryption?: CredentialResponseEncryption;

  /** Batch credential issuance support */
  batch_credential_issuance?: BatchCredentialIssuance;

  /** Signed metadata support */
  signed_metadata?: string;

  /** Display information */
  display?: IssuerDisplay[];

  /** Credential configurations */
  credential_configurations_supported: Record<string, CredentialConfiguration>;
}

/**
 * Credential Response Encryption
 */
export interface CredentialResponseEncryption {
  /** Supported algorithms */
  alg_values_supported: string[];

  /** Supported encryption methods */
  enc_values_supported: string[];

  /** Encryption required */
  encryption_required: boolean;
}

/**
 * Batch Credential Issuance
 */
export interface BatchCredentialIssuance {
  /** Maximum batch size */
  batch_size: number;
}

/**
 * Issuer Display
 */
export interface IssuerDisplay {
  /** Issuer name */
  name?: string;

  /** Locale */
  locale?: string;

  /** Logo */
  logo?: Logo;

  /** Description */
  description?: string;

  /** Background color */
  background_color?: string;

  /** Text color */
  text_color?: string;
}

/**
 * Logo
 */
export interface Logo {
  /** Logo URI */
  uri: string;

  /** Alt text */
  alt_text?: string;
}

// =============================================================================
// Credential Configuration
// =============================================================================

/**
 * Credential Configuration
 */
export interface CredentialConfiguration {
  /** Credential format */
  format: HaipCredentialFormat;

  /** Credential definition (for jwt_vc_json) */
  credential_definition?: CredentialDefinition;

  /** VCT (Verifiable Credential Type) for dc+sd-jwt */
  vct?: string;

  /** Doctype for mso_mdoc */
  doctype?: string;

  /** Scope */
  scope?: string;

  /** Cryptographic binding methods */
  cryptographic_binding_methods_supported?: CryptographicBindingMethod[];

  /** Credential signing algorithms */
  credential_signing_alg_values_supported?: HaipSignatureAlgorithm[];

  /** Proof types */
  proof_types_supported?: Record<string, ProofTypeSupport>;

  /** Display */
  display?: CredentialDisplay[];

  /** Claims */
  claims?: Record<string, ClaimConfiguration>;

  /** Order of claims (for display) */
  order?: string[];
}

/**
 * Credential Definition
 */
export interface CredentialDefinition {
  /** Credential types */
  type?: string[];

  /** Credential subject claims */
  credentialSubject?: Record<string, ClaimConfiguration>;
}

/**
 * Cryptographic Binding Methods
 */
export type CryptographicBindingMethod = 'jwk' | 'cose_key' | 'did';

/**
 * Proof Type Support
 */
export interface ProofTypeSupport {
  /** Proof signing algorithms */
  proof_signing_alg_values_supported: HaipSignatureAlgorithm[];
}

/**
 * Credential Display
 */
export interface CredentialDisplay {
  /** Credential name */
  name: string;

  /** Locale */
  locale?: string;

  /** Logo */
  logo?: Logo;

  /** Description */
  description?: string;

  /** Background color */
  background_color?: string;

  /** Background image */
  background_image?: BackgroundImage;

  /** Text color */
  text_color?: string;
}

/**
 * Background Image
 */
export interface BackgroundImage {
  /** Image URI */
  uri: string;

  /** Alt text */
  alt_text?: string;
}

/**
 * Claim Configuration
 */
export interface ClaimConfiguration {
  /** Whether claim is mandatory */
  mandatory?: boolean;

  /** Value type */
  value_type?: string;

  /** Display information */
  display?: ClaimDisplay[];
}

/**
 * Claim Display
 */
export interface ClaimDisplay {
  /** Claim name */
  name?: string;

  /** Locale */
  locale?: string;
}

// =============================================================================
// Credential Offer
// =============================================================================

/**
 * Credential Offer
 * Sent by Issuer to initiate issuance
 */
export interface CredentialOffer {
  /** Credential issuer identifier */
  credential_issuer: string;

  /** Credential configuration IDs */
  credential_configuration_ids: string[];

  /** Grants */
  grants?: CredentialOfferGrants;
}

/**
 * Credential Offer Grants
 */
export interface CredentialOfferGrants {
  /** Authorization code grant */
  authorization_code?: AuthorizationCodeGrant;

  /** Pre-authorized code grant */
  'urn:ietf:params:oauth:grant-type:pre-authorized_code'?: PreAuthorizedCodeGrant;
}

/**
 * Authorization Code Grant
 */
export interface AuthorizationCodeGrant {
  /** Issuer state */
  issuer_state?: string;

  /** Authorization server URL */
  authorization_server?: string;
}

/**
 * Pre-Authorized Code Grant
 */
export interface PreAuthorizedCodeGrant {
  /** Pre-authorized code */
  'pre-authorized_code': string;

  /** Transaction code (PIN) */
  tx_code?: TransactionCode;

  /** Authorization server URL */
  authorization_server?: string;
}

/**
 * Transaction Code (PIN)
 */
export interface TransactionCode {
  /** Input mode */
  input_mode?: 'numeric' | 'text';

  /** Length */
  length?: number;

  /** Description */
  description?: string;
}

/**
 * Credential Offer URI
 */
export interface CredentialOfferUri {
  /** Credential offer URI */
  credential_offer_uri: string;
}

// =============================================================================
// Token Request/Response
// =============================================================================

/**
 * Token Request (Pre-Authorized Code)
 */
export interface PreAuthorizedTokenRequest {
  /** Grant type */
  grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code';

  /** Pre-authorized code */
  'pre-authorized_code': string;

  /** Transaction code (PIN) */
  tx_code?: string;
}

/**
 * Token Response
 */
export interface VCITokenResponse {
  /** Access token */
  access_token: string;

  /** Token type */
  token_type: 'Bearer' | 'DPoP';

  /** Expires in seconds */
  expires_in?: number;

  /** c_nonce for credential request */
  c_nonce?: string;

  /** c_nonce expires in seconds */
  c_nonce_expires_in?: number;

  /** Authorization details */
  authorization_details?: AuthorizationDetail[];
}

/**
 * Authorization Detail
 */
export interface AuthorizationDetail {
  /** Type */
  type: 'openid_credential';

  /** Credential configuration ID */
  credential_configuration_id?: string;

  /** Credential identifiers (for deferred) */
  credential_identifiers?: string[];
}

// =============================================================================
// Credential Request/Response
// =============================================================================

/**
 * Credential Request
 */
export interface CredentialRequest {
  /** Credential configuration ID */
  credential_identifier?: string;

  /** Format */
  format?: HaipCredentialFormat;

  /** Proof of possession */
  proof?: CredentialProof;

  /** Credential response encryption */
  credential_response_encryption?: CredentialRequestEncryption;

  /** VCT (for dc+sd-jwt) */
  vct?: string;

  /** Doctype (for mso_mdoc) */
  doctype?: string;

  /** Claims (selective disclosure) */
  claims?: Record<string, ClaimRequest>;
}

/**
 * Credential Proof
 */
export interface CredentialProof {
  /** Proof type */
  proof_type: 'jwt' | 'cwt' | 'ldp_vp';

  /** JWT proof */
  jwt?: string;

  /** CWT proof */
  cwt?: string;

  /** LDP VP proof */
  ldp_vp?: unknown;
}

/**
 * Credential Request Encryption
 */
export interface CredentialRequestEncryption {
  /** JWK for encryption */
  jwk: Record<string, unknown>;

  /** Algorithm */
  alg: string;

  /** Encryption method */
  enc: string;
}

/**
 * Claim Request
 */
export interface ClaimRequest {
  /** Mandatory flag */
  mandatory?: boolean;
}

/**
 * Credential Response
 */
export interface CredentialResponse {
  /** Credential (issued) */
  credential?: string;

  /** Credentials (batch) */
  credentials?: IssuedCredential[];

  /** Transaction ID (for deferred) */
  transaction_id?: string;

  /** New c_nonce */
  c_nonce?: string;

  /** c_nonce expires in */
  c_nonce_expires_in?: number;

  /** Notification ID */
  notification_id?: string;
}

/**
 * Issued Credential
 */
export interface IssuedCredential {
  /** Credential */
  credential: string;

  /** Notification ID */
  notification_id?: string;
}

/**
 * Credential Error Response
 */
export interface CredentialErrorResponse {
  /** Error code */
  error: CredentialError;

  /** Error description */
  error_description?: string;

  /** New c_nonce */
  c_nonce?: string;

  /** c_nonce expires in */
  c_nonce_expires_in?: number;
}

/**
 * Credential Errors
 */
export type CredentialError =
  | 'invalid_request'
  | 'invalid_token'
  | 'unsupported_credential_type'
  | 'unsupported_credential_format'
  | 'invalid_proof'
  | 'invalid_encryption_parameters'
  | 'credential_request_denied'
  | 'issuance_pending';

// =============================================================================
// Batch Credential
// =============================================================================

/**
 * Batch Credential Request
 */
export interface BatchCredentialRequest {
  /** Credential requests */
  credential_requests: CredentialRequest[];
}

/**
 * Batch Credential Response
 */
export interface BatchCredentialResponse {
  /** Credential responses */
  credential_responses: CredentialResponse[];

  /** New c_nonce */
  c_nonce?: string;

  /** c_nonce expires in */
  c_nonce_expires_in?: number;
}

// =============================================================================
// Deferred Credential
// =============================================================================

/**
 * Deferred Credential Request
 */
export interface DeferredCredentialRequest {
  /** Transaction ID */
  transaction_id: string;
}

/**
 * Deferred Credential Response
 */
export type DeferredCredentialResponse = CredentialResponse | CredentialErrorResponse;

// =============================================================================
// Notification
// =============================================================================

/**
 * Notification Request
 */
export interface NotificationRequest {
  /** Notification ID */
  notification_id: string;

  /** Event */
  event: NotificationEvent;

  /** Event description */
  event_description?: string;
}

/**
 * Notification Events
 */
export type NotificationEvent = 'credential_accepted' | 'credential_failure' | 'credential_deleted';

// =============================================================================
// Credential Offer State
// =============================================================================

/**
 * Credential Offer Status
 */
export type CredentialOfferStatus = 'pending' | 'accepted' | 'issued' | 'failed' | 'expired';

/**
 * Credential Offer (stored in Durable Object)
 */
export interface StoredCredentialOffer {
  /** Offer ID */
  id: string;

  /** Tenant ID */
  tenantId: string;

  /** User ID */
  userId: string;

  /** Credential configuration ID */
  credentialConfigurationId: string;

  /** Pre-authorized code */
  preAuthorizedCode?: string;

  /** Transaction code (PIN) */
  txCode?: string;

  /** Grants configuration */
  grants: CredentialOfferGrants;

  /** Offer status */
  status: CredentialOfferStatus;

  /** Claims to include in credential */
  claims: Record<string, unknown>;

  /** Created timestamp */
  createdAt: number;

  /** Expires timestamp */
  expiresAt: number;

  /** Issued timestamp */
  issuedAt?: number;

  /** Issued credential ID */
  issuedCredentialId?: string;
}

// =============================================================================
// Issued Credential State
// =============================================================================

/**
 * Issued Credential Status
 */
export type IssuedCredentialStatus = 'active' | 'suspended' | 'revoked';

/**
 * Issued Credential (stored in database)
 */
export interface StoredIssuedCredential {
  /** Credential ID */
  id: string;

  /** Tenant ID */
  tenantId: string;

  /** User ID */
  userId: string;

  /** Credential type (VCT) */
  credentialType: string;

  /** Format */
  format: HaipCredentialFormat;

  /** Claims included */
  claims: Record<string, unknown>;

  /** Credential status */
  status: IssuedCredentialStatus;

  /** Status list index (for revocation) */
  statusListIndex?: number;

  /** Created timestamp */
  createdAt: number;

  /** Expires timestamp */
  expiresAt?: number;

  /** Revoked timestamp */
  revokedAt?: number;

  /** Revoked reason */
  revokedReason?: string;
}
