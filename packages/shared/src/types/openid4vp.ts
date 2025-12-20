/**
 * OpenID4VP (OpenID for Verifiable Presentations) Types
 *
 * Type definitions for OpenID4VP 1.0 Final (July 2025)
 * Implements the Verifier role for accepting VCs from digital wallets.
 *
 * @see https://openid.net/specs/openid-4-verifiable-presentations-1_0.html
 */

import type { HaipCredentialFormat, HaipSignatureAlgorithm } from '../vc/haip-policy';

// =============================================================================
// Authorization Request
// =============================================================================

/**
 * OpenID4VP Authorization Request
 * Sent by Verifier to Wallet
 */
export interface VPAuthorizationRequest {
  /** Response type (always 'vp_token' for OpenID4VP) */
  response_type: 'vp_token' | 'vp_token id_token';

  /** Client ID (Verifier identifier) */
  client_id: string;

  /** Response mode */
  response_mode: VPResponseMode;

  /** Response URI for direct_post mode */
  response_uri?: string;

  /** Redirect URI for fragment/query modes */
  redirect_uri?: string;

  /** State parameter for session binding */
  state?: string;

  /** Nonce for replay protection */
  nonce: string;

  /** Presentation definition (legacy) */
  presentation_definition?: PresentationDefinition;

  /** Presentation definition URI (legacy) */
  presentation_definition_uri?: string;

  /** DCQL query (HAIP preferred) */
  dcql_query?: DCQLQuery;

  /** Client ID scheme */
  client_id_scheme?: ClientIdScheme;

  /** Client metadata */
  client_metadata?: VPClientMetadata;

  /** Client metadata URI */
  client_metadata_uri?: string;

  /** Request object (JAR) */
  request?: string;

  /** Request object URI */
  request_uri?: string;
}

/**
 * VP Response Modes
 */
export type VPResponseMode = 'direct_post' | 'direct_post.jwt' | 'fragment' | 'query';

/**
 * Client ID Schemes
 */
export type ClientIdScheme =
  | 'pre-registered'
  | 'redirect_uri'
  | 'entity_id'
  | 'did'
  | 'verifier_attestation'
  | 'x509_san_dns'
  | 'x509_san_uri';

/**
 * VP Client Metadata
 */
export interface VPClientMetadata {
  /** Verifier name */
  client_name?: string;

  /** Verifier logo URI */
  logo_uri?: string;

  /** Supported VP formats */
  vp_formats?: VPFormats;

  /** Localized client names */
  client_name_localized?: Record<string, string>;
}

/**
 * VP Formats configuration
 */
export interface VPFormats {
  /** SD-JWT VC format */
  'dc+sd-jwt'?: {
    /** Supported signature algorithms */
    sd_jwt_alg_values?: HaipSignatureAlgorithm[];
    /** Supported KB-JWT algorithms */
    kb_jwt_alg_values?: HaipSignatureAlgorithm[];
  };

  /** mso_mdoc format (ISO 18013-5) */
  mso_mdoc?: {
    /** Supported signature algorithms */
    alg_values?: string[];
  };

  /** JWT VP format (legacy) */
  jwt_vp?: {
    alg_values?: string[];
  };
}

// =============================================================================
// DCQL (Digital Credentials Query Language)
// =============================================================================

/**
 * DCQL Query
 * HAIP-preferred method for requesting credentials
 */
export interface DCQLQuery {
  /** Requested credentials */
  credentials: DCQLCredential[];

  /** Credential sets for complex requirements */
  credential_sets?: DCQLCredentialSet[];
}

/**
 * DCQL Credential
 */
export interface DCQLCredential {
  /** Unique identifier for this credential request */
  id: string;

  /** Credential format */
  format: HaipCredentialFormat;

  /** Format-specific metadata */
  meta?: DCQLCredentialMeta;

  /** Requested claims */
  claims?: DCQLClaimQuery[];

  /** Claim sets for alternative claim combinations */
  claim_sets?: DCQLClaimSet[];

  /** Trust frameworks */
  trust_frameworks?: string[];
}

/**
 * DCQL Credential Metadata
 */
export interface DCQLCredentialMeta {
  /** VCT values for dc+sd-jwt */
  vct_values?: string[];

  /** Doctype value for mso_mdoc */
  doctype_value?: string;
}

/**
 * DCQL Claim Query
 */
export interface DCQLClaimQuery {
  /** Claim path (e.g., 'given_name', 'address.country') */
  path: string[];

  /** Claim ID (for mapping in response) */
  id?: string;

  /** Expected values */
  values?: unknown[];
}

/**
 * DCQL Claim Set
 */
export interface DCQLClaimSet {
  /** Claim set options */
  options: DCQLClaimQuery[][];
}

/**
 * DCQL Credential Set
 */
export interface DCQLCredentialSet {
  /** Set options (OR logic between arrays) */
  options: string[][];

  /** Required flag */
  required?: boolean;

  /** Purpose description */
  purpose?: string;
}

// =============================================================================
// Presentation Definition (Legacy)
// =============================================================================

/**
 * Presentation Definition (DIF Presentation Exchange)
 * Supported for backward compatibility, DCQL preferred
 */
export interface PresentationDefinition {
  /** Definition ID */
  id: string;

  /** Human-readable name */
  name?: string;

  /** Purpose description */
  purpose?: string;

  /** Supported formats */
  format?: VPFormats;

  /** Input descriptors */
  input_descriptors: InputDescriptor[];

  /** Submission requirements */
  submission_requirements?: SubmissionRequirement[];
}

/**
 * Input Descriptor
 */
export interface InputDescriptor {
  /** Descriptor ID */
  id: string;

  /** Human-readable name */
  name?: string;

  /** Purpose description */
  purpose?: string;

  /** Supported formats for this descriptor */
  format?: VPFormats;

  /** Constraints on the credential */
  constraints: InputDescriptorConstraints;

  /**
   * Group memberships for submission_requirements
   * Used when submission_requirements reference groups
   */
  group?: string[];
}

/**
 * Input Descriptor Constraints
 */
export interface InputDescriptorConstraints {
  /** Field constraints */
  fields?: FieldConstraint[];

  /** Limit disclosure */
  limit_disclosure?: 'required' | 'preferred';
}

/**
 * Field Constraint
 */
export interface FieldConstraint {
  /** JSON path(s) to the field */
  path: string[];

  /** Field ID */
  id?: string;

  /** Purpose */
  purpose?: string;

  /** Filter (JSON Schema) */
  filter?: Record<string, unknown>;

  /** Optional flag */
  optional?: boolean;
}

/**
 * Submission Requirement
 */
export interface SubmissionRequirement {
  /** Rule type */
  rule: 'all' | 'pick';

  /** Count (for 'pick' rule) */
  count?: number;

  /** Minimum count */
  min?: number;

  /** Maximum count */
  max?: number;

  /** From input descriptors */
  from?: string;

  /** From nested requirements */
  from_nested?: SubmissionRequirement[];
}

// =============================================================================
// Authorization Response
// =============================================================================

/**
 * VP Authorization Response
 * Sent by Wallet to Verifier
 */
export interface VPAuthorizationResponse {
  /** VP Token (credential presentation) */
  vp_token: string | string[];

  /** Presentation submission */
  presentation_submission?: PresentationSubmission;

  /** State from request */
  state?: string;

  /** ID Token (if requested) */
  id_token?: string;
}

/**
 * VP Authorization Error Response
 */
export interface VPAuthorizationErrorResponse {
  /** Error code */
  error: VPAuthorizationError;

  /** Error description */
  error_description?: string;

  /** State from request */
  state?: string;
}

/**
 * VP Authorization Errors
 */
export type VPAuthorizationError =
  | 'invalid_request'
  | 'unauthorized_client'
  | 'access_denied'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'server_error'
  | 'temporarily_unavailable'
  | 'vp_formats_not_supported'
  | 'invalid_presentation_definition'
  | 'invalid_presentation_definition_uri'
  | 'dcql_query_not_satisfied';

/**
 * Presentation Submission
 */
export interface PresentationSubmission {
  /** Submission ID */
  id: string;

  /** Presentation definition ID */
  definition_id: string;

  /** Descriptor map */
  descriptor_map: DescriptorMapEntry[];
}

/**
 * Descriptor Map Entry
 */
export interface DescriptorMapEntry {
  /** Input descriptor ID */
  id: string;

  /** Credential format */
  format: string;

  /** Path to the credential */
  path: string;

  /** Path within nested structure */
  path_nested?: DescriptorMapEntry;
}

// =============================================================================
// Verifier Metadata
// =============================================================================

/**
 * Verifier Metadata
 * Published at /.well-known/openid-credential-verifier
 */
export interface VerifierMetadata {
  /** Verifier identifier (DID or URL) */
  verifier_id: string;

  /** Verifier name */
  name?: string;

  /** Response URI */
  response_uri?: string;

  /** Supported VP formats */
  vp_formats: VPFormats;

  /** Supported client ID schemes */
  client_id_schemes_supported?: ClientIdScheme[];

  /** Supported response modes */
  response_modes_supported?: VPResponseMode[];

  /** Supported presentation definition formats */
  presentation_definition_uri_supported?: boolean;

  /** DCQL support */
  dcql_query_supported?: boolean;

  /** Request object support */
  request_object_signing_alg_values_supported?: string[];

  /** Logo URI */
  logo_uri?: string;

  /** Policy URI */
  policy_uri?: string;

  /** Terms of service URI */
  tos_uri?: string;
}

// =============================================================================
// VP Request State
// =============================================================================

/**
 * VP Request Status
 */
export type VPRequestStatus = 'pending' | 'submitted' | 'verified' | 'failed' | 'expired';

/**
 * VP Request (stored in Durable Object)
 */
export interface VPRequest {
  /** Request ID */
  id: string;

  /** Tenant ID */
  tenantId: string;

  /** Client ID (Verifier) */
  clientId: string;

  /** Nonce */
  nonce: string;

  /** State */
  state?: string;

  /** Presentation definition ID (if using stored definition) */
  presentationDefinitionId?: string;

  /** Inline DCQL query */
  dcqlQuery?: DCQLQuery;

  /** Response URI */
  responseUri: string;

  /** Response mode */
  responseMode: VPResponseMode;

  /** Request status */
  status: VPRequestStatus;

  /** Received VP token (temporary, for processing) */
  vpToken?: string;

  /** Verification result */
  verificationResult?: VPVerificationResult;

  /** Error code if failed */
  errorCode?: string;

  /** Error description */
  errorDescription?: string;

  /** Created timestamp */
  createdAt: number;

  /** Expires timestamp */
  expiresAt: number;

  /** Verified timestamp */
  verifiedAt?: number;
}

/**
 * VP Verification Result
 */
export interface VPVerificationResult {
  /** Verification success */
  verified: boolean;

  /** Issuer DID */
  issuerDid: string;

  /** Credential type (VCT) */
  credentialType: string;

  /** Credential format */
  format: HaipCredentialFormat;

  /** Holder binding verified */
  holderBindingVerified: boolean;

  /** Issuer trusted */
  issuerTrusted: boolean;

  /** Status valid (not revoked) */
  statusValid: boolean;

  /** Disclosed claims (sanitized) */
  disclosedClaims: Record<string, unknown>;

  /** Claims extracted for user attributes */
  extractedAttributes: ExtractedAttribute[];

  /** Verification timestamp */
  verifiedAt: number;
}

/**
 * Extracted Attribute from VC
 */
export interface ExtractedAttribute {
  /** Attribute name (normalized) */
  name: string;

  /** Attribute value */
  value: string;

  /** Source claim path */
  sourceClaim: string;
}
