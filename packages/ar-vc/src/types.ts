/**
 * VC Package Types
 *
 * Type definitions for the unified VC worker (VP + VCI + DID).
 */

import type { PresentationDefinition, DCQLQuery } from '@authrim/ar-lib-core';

// =============================================================================
// Environment Bindings
// =============================================================================

export interface Env {
  // D1 Database
  DB: D1Database;
  DB_ADMIN?: D1Database;

  // KV Namespace (same as other packages for shared config)
  AUTHRIM_CONFIG: KVNamespace;

  // Durable Objects
  VP_REQUEST_STORE: DurableObjectNamespace;
  CREDENTIAL_OFFER_STORE: DurableObjectNamespace;
  KEY_MANAGER: DurableObjectNamespace;
  RATE_LIMITER?: DurableObjectNamespace;

  // Service Bindings
  POLICY_SERVICE: Fetcher;

  // Verifier Environment Variables
  VERIFIER_IDENTIFIER: string;
  VC_ATTRIBUTE_ELEVATION_AUDIENCE?: string;
  HAIP_POLICY_VERSION: string;
  VP_REQUEST_EXPIRY_SECONDS: string;
  NONCE_EXPIRY_SECONDS: string;

  // Issuer Environment Variables
  ISSUER_IDENTIFIER: string;
  CREDENTIAL_OFFER_EXPIRY_SECONDS: string;
  C_NONCE_EXPIRY_SECONDS: string;
  VC_TRANSACTION_CODE_HMAC_SECRET?: string;
  VC_EVIDENCE_HMAC_SECRET?: string;
  VC_PROFILE_CONTRACT_HMAC_SECRET?: string;
  RATE_LIMIT_PROFILE?: string;
}

// =============================================================================
// Verifier Metadata
// =============================================================================

/**
 * OpenID4VP Verifier Metadata
 * @see https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#name-verifier-metadata
 */
export interface VerifierMetadata {
  /** Verifier identifier (DID or URL) */
  verifier_identifier: string;

  /** Supported VP formats */
  vp_formats_supported: VPFormatsSupported;

  /** Supported client ID schemes */
  client_id_schemes_supported: ClientIdScheme[];

  /** Response types supported */
  response_types_supported: string[];

  /** Response modes supported */
  response_modes_supported: string[];

  /** Whether DCQL is supported */
  dcql_supported?: boolean;

  /** Presentation definition URI schemes supported */
  presentation_definition_uri_schemes_supported?: string[];
}

export interface VPFormatsSupported {
  /** SD-JWT VC format */
  'dc+sd-jwt'?: {
    alg_values_supported: string[];
  };

  /** mDL format */
  mso_mdoc?: {
    alg_values_supported: string[];
  };

  /** Legacy JWT VC format (not HAIP compliant) */
  jwt_vc_json?: {
    alg_values_supported: string[];
  };
}

export type ClientIdScheme =
  | 'pre-registered'
  | 'redirect_uri'
  | 'entity_id'
  | 'did'
  | 'x509_san_dns'
  | 'x509_san_uri';

// =============================================================================
// VP Request State
// =============================================================================

/**
 * VP Request stored in Durable Object
 */
export interface VPRequestState {
  /** Request ID */
  id: string;

  /** Tenant ID */
  tenantId: string;

  /** Client ID (RP identifier) */
  clientId: string;

  /** User ID (for authenticated attribute verification) */
  userId?: string;
  credentialProfileId?: string;
  credentialProfileVersionId?: string;
  verificationFlowVersionId?: string;
  verificationMappingVersionId?: string;
  verificationMappingSnapshotHash?: string;
  maximumAttributeAgeSeconds?: number;

  /** Nonce for replay protection */
  nonce: string;

  /** State parameter */
  state?: string;

  /** Digest of the bearer capability used only for status polling. */
  statusTokenHash?: string;

  /** Presentation definition */
  presentationDefinition?: PresentationDefinition | object;

  /** DCQL query (alternative to presentation definition) */
  dcqlQuery?: DCQLQuery;

  /** Response URI for direct_post */
  responseUri: string;

  /** Response mode */
  responseMode: 'direct_post' | 'direct_post.jwt';

  /** Request status */
  status: VPRequestStatus;

  /** Names of verified claims. Values are deliberately never persisted. */
  verifiedClaimNames?: string[];

  /** Error code (if failed) */
  errorCode?: string;

  /** Error description */
  errorDescription?: string;

  /** Created timestamp */
  createdAt: number;

  /** Expires timestamp */
  expiresAt: number;
}

export type VPRequestStatus = 'pending' | 'processing' | 'verified' | 'failed' | 'expired';

// =============================================================================
// Verification Result
// =============================================================================

/**
 * VP Token Verification Result
 */
export interface VPVerificationResult {
  /** Whether verification succeeded */
  verified: boolean;

  /** Issuer DID */
  issuerDid?: string;

  /** Credential type (VCT) */
  credentialType?: string;

  /** Credential format */
  format?: 'dc+sd-jwt' | 'mso_mdoc';

  /** Disclosed claims */
  disclosedClaims?: Record<string, unknown>;

  /** Whether holder binding was verified */
  holderBindingVerified: boolean;

  /** Whether issuer is trusted */
  issuerTrusted: boolean;

  /** Whether credential status is valid */
  statusValid: boolean;
  credentialExpiresAt?: number;
  statusCheckedAt?: number;
  statusFreshUntil?: number;

  /** Verification errors */
  errors: string[];

  /** Verification warnings */
  warnings: string[];

  /** HAIP compliance status */
  haipCompliant: boolean;
}

// =============================================================================
// Trusted Issuer
// =============================================================================

/**
 * Trusted Issuer record from database
 */
export interface TrustedIssuer {
  id: string;
  tenantId: string;
  issuerDid: string;
  displayName?: string;
  credentialTypes: string[];
  trustLevel: 'standard' | 'high';
  jwksUri?: string;
  status: 'active' | 'suspended' | 'revoked';
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Attribute Verification Record
// =============================================================================

/**
 * Record of attribute verification from VC
 * Stored in database - raw VC is NOT stored
 */
export interface AttributeVerificationRecord {
  id: string;
  tenantId: string;
  userId: string;
  vpRequestId: string;
  issuerDid: string;
  credentialType: string;
  format: 'dc+sd-jwt' | 'mso_mdoc';
  verificationResult: 'verified' | 'failed' | 'expired';
  holderBindingVerified: boolean;
  issuerTrusted: boolean;
  statusValid: boolean;
  mappedAttributeIds?: string[];
  verifiedAt: string;
  expiresAt?: string;
}

// =============================================================================
// Config Values
// =============================================================================

/**
 * Verifier configuration from KV
 */
export interface VerifierConfig {
  /** VP request expiry in seconds */
  vpRequestExpirySeconds: number;

  /** Nonce expiry in seconds */
  nonceExpirySeconds: number;

  /** HAIP policy version */
  haipPolicyVersion: 'draft-06' | 'final-1.0';

  /** Whether to require holder binding */
  requireHolderBinding: boolean;

  /** Whether to require issuer trust */
  requireIssuerTrust: boolean;

  /** Whether to check credential status */
  checkCredentialStatus: boolean;

  /** Allowed credential formats */
  allowedFormats: ('dc+sd-jwt' | 'mso_mdoc')[];

  /** Allowed algorithms */
  allowedAlgorithms: string[];
}
