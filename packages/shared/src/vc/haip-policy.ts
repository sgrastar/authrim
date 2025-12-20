/**
 * HAIP (High Assurance Interoperability Profile) Abstraction Layer
 *
 * Implements the HAIP profile for OpenID4VP and OpenID4VCI.
 * This layer abstracts HAIP-specific requirements to allow easy migration
 * when the specification transitions from draft to Final.
 *
 * Current: draft-oid4vc-haip-sd-jwt-vc-06
 *
 * @see https://openid.net/specs/openid4vc-high-assurance-interoperability-profile-sd-jwt-vc-1_0.html
 */

/**
 * HAIP Policy configuration
 * Defines the requirements for high-assurance credential verification
 */
export interface HaipPolicy {
  /** Require holder binding verification (KB-JWT) */
  requireHolderBinding: boolean;

  /** Require issuer to be in trusted registry */
  requireIssuerTrust: boolean;

  /** Require credential status check (Status List 2021) */
  requireStatusCheck: boolean;

  /** Allowed signature algorithms */
  allowedAlgorithms: HaipSignatureAlgorithm[];

  /** Maximum credential age in seconds (optional) */
  maxCredentialAge?: number;

  /** Allowed credential formats */
  allowedFormats: HaipCredentialFormat[];

  /** Require DCQL for presentation definition (vs legacy Presentation Exchange) */
  preferDCQL: boolean;

  /** Require direct_post response mode */
  requireDirectPost: boolean;

  // ==========================================================================
  // Optional HAIP Requirements (for 100% compliance)
  // ==========================================================================

  /** Require JWT-Secured Authorization Request (JAR) */
  requireRequestObject?: boolean;

  /** Require nonce in KB-JWT (replay protection) */
  requireNonceInKBJWT?: boolean;

  /** Require aud claim in KB-JWT to match verifier ID */
  requireAudienceInKBJWT?: boolean;

  /** Allowed client ID schemes (HAIP: x509_san_dns, verifier_attestation required; did, x509_san_uri optional) */
  allowedClientIdSchemes?: HaipClientIdScheme[];

  /** Require confirmation claim (cnf) to use JWK thumbprint (jkt) vs full JWK */
  requireJktInCnf?: boolean;

  /** Require type header (typ: "dc+sd-jwt") in issuer JWT */
  requireTypHeader?: boolean;

  /** Maximum allowed clock skew in seconds */
  maxClockSkew?: number;

  /** Require trust chain header for issuer verification */
  requireTrustChain?: boolean;

  /** Trust anchors for X.509 certificate chain validation */
  trustAnchors?: string[];
}

/**
 * HAIP-compliant Client ID Schemes
 */
export type HaipClientIdScheme =
  | 'pre-registered'
  | 'redirect_uri'
  | 'entity_id'
  | 'did'
  | 'verifier_attestation'
  | 'x509_san_dns'
  | 'x509_san_uri';

/**
 * HAIP-compliant signature algorithms
 * HAIP requires ES256, ES384, or ES512 for SD-JWT VC
 */
export type HaipSignatureAlgorithm = 'ES256' | 'ES384' | 'ES512';

/**
 * HAIP-compliant credential formats
 */
export type HaipCredentialFormat = 'dc+sd-jwt' | 'mso_mdoc';

/**
 * HAIP Profile versions
 */
export type HaipProfileVersion = 'draft-06' | 'final-1.0';

/**
 * HAIP draft-06 default policy
 * Strict requirements for high-assurance use cases
 */
export const HAIP_DRAFT_06: HaipPolicy = {
  // Core requirements
  requireHolderBinding: true,
  requireIssuerTrust: true,
  requireStatusCheck: true,
  allowedAlgorithms: ['ES256', 'ES384', 'ES512'],
  allowedFormats: ['dc+sd-jwt', 'mso_mdoc'],
  preferDCQL: true,
  requireDirectPost: true,

  // Optional requirements (for strict HAIP compliance)
  requireRequestObject: true,
  requireNonceInKBJWT: true,
  requireAudienceInKBJWT: true,
  allowedClientIdSchemes: ['x509_san_dns', 'verifier_attestation', 'did', 'x509_san_uri'],
  requireJktInCnf: true,
  requireTypHeader: true,
  maxClockSkew: 300, // 5 minutes
  requireTrustChain: false, // Optional per spec
};

/**
 * Standard (non-HAIP) policy
 * Relaxed requirements for general use cases
 */
export const STANDARD_POLICY: HaipPolicy = {
  requireHolderBinding: true, // Still recommended
  requireIssuerTrust: false, // Allow any issuer
  requireStatusCheck: false, // Optional
  allowedAlgorithms: ['ES256', 'ES384', 'ES512'],
  allowedFormats: ['dc+sd-jwt', 'mso_mdoc'],
  preferDCQL: false, // Allow legacy Presentation Exchange
  requireDirectPost: false,
};

/**
 * Get HAIP policy by version
 *
 * @param version - HAIP profile version
 * @returns HaipPolicy for the specified version
 */
export function getHaipPolicy(version: HaipProfileVersion): HaipPolicy {
  switch (version) {
    case 'draft-06':
      return { ...HAIP_DRAFT_06 };
    case 'final-1.0':
      // When Final is released, update this
      // For now, use draft-06 as baseline
      return { ...HAIP_DRAFT_06 };
    default:
      return { ...HAIP_DRAFT_06 };
  }
}

/**
 * HAIP Credential Type requirements
 * Maps VCT to required claims for HAIP compliance
 */
export interface HaipCredentialTypeRequirement {
  /** Verifiable Credential Type (VCT) */
  vct: string;

  /** Required claims that must be present */
  requiredClaims: string[];

  /** Claims that must be selectively disclosable */
  selectiveDisclosureClaims: string[];

  /** Minimum assurance level */
  minAssuranceLevel?: 'low' | 'substantial' | 'high';
}

/**
 * Common HAIP credential types
 */
export const HAIP_CREDENTIAL_TYPES: Record<string, HaipCredentialTypeRequirement> = {
  // EU PID (Person Identification Data)
  'eu.europa.ec.eudi.pid.1': {
    vct: 'eu.europa.ec.eudi.pid.1',
    requiredClaims: ['iss', 'iat', 'exp', 'cnf'],
    selectiveDisclosureClaims: [
      'given_name',
      'family_name',
      'birthdate',
      'age_over_18',
      'age_over_21',
      'nationality',
      'resident_country',
    ],
    minAssuranceLevel: 'high',
  },

  // mDL (Mobile Driving License) - ISO 18013-5
  'org.iso.18013.5.1.mDL': {
    vct: 'org.iso.18013.5.1.mDL',
    requiredClaims: ['iss', 'iat', 'exp', 'cnf'],
    selectiveDisclosureClaims: [
      'family_name',
      'given_name',
      'birth_date',
      'portrait',
      'driving_privileges',
      'document_number',
    ],
    minAssuranceLevel: 'high',
  },

  // Age Verification
  'urn:authrim:age-verification:1': {
    vct: 'urn:authrim:age-verification:1',
    requiredClaims: ['iss', 'iat', 'exp', 'cnf'],
    selectiveDisclosureClaims: ['age_over_18', 'age_over_21', 'birthdate'],
    minAssuranceLevel: 'substantial',
  },
};

/**
 * HAIP Policy Evaluator
 *
 * Evaluates credentials and presentations against HAIP requirements.
 * Abstracts HAIP-specific logic for easy migration when spec changes.
 */
export class HaipPolicyEvaluator {
  private policy: HaipPolicy;

  constructor(policy: HaipPolicy = HAIP_DRAFT_06) {
    this.policy = policy;
  }

  /**
   * Check if a signature algorithm is allowed
   */
  isAlgorithmAllowed(alg: string): boolean {
    return this.policy.allowedAlgorithms.includes(alg as HaipSignatureAlgorithm);
  }

  /**
   * Check if a credential format is allowed
   */
  isFormatAllowed(format: string): boolean {
    return this.policy.allowedFormats.includes(format as HaipCredentialFormat);
  }

  /**
   * Check if holder binding is required
   */
  isHolderBindingRequired(): boolean {
    return this.policy.requireHolderBinding;
  }

  /**
   * Check if issuer trust verification is required
   */
  isIssuerTrustRequired(): boolean {
    return this.policy.requireIssuerTrust;
  }

  /**
   * Check if status check is required
   */
  isStatusCheckRequired(): boolean {
    return this.policy.requireStatusCheck;
  }

  /**
   * Check if credential is within max age
   */
  isWithinMaxAge(issuedAt: number): boolean {
    if (!this.policy.maxCredentialAge) {
      return true; // No max age restriction
    }

    const ageInSeconds = (Date.now() - issuedAt * 1000) / 1000;
    return ageInSeconds <= this.policy.maxCredentialAge;
  }

  /**
   * Get the current policy configuration
   */
  getPolicy(): Readonly<HaipPolicy> {
    return { ...this.policy };
  }

  /**
   * Update policy (for dynamic configuration)
   */
  updatePolicy(updates: Partial<HaipPolicy>): void {
    this.policy = { ...this.policy, ...updates };
  }

  /**
   * Validate a credential verification result against HAIP requirements
   */
  validateVerificationResult(result: HaipVerificationInput): HaipValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check algorithm
    if (!this.isAlgorithmAllowed(result.algorithm)) {
      errors.push(
        `Algorithm '${result.algorithm}' is not allowed. Allowed: ${this.policy.allowedAlgorithms.join(', ')}`
      );
    }

    // Check format
    if (!this.isFormatAllowed(result.format)) {
      errors.push(
        `Format '${result.format}' is not allowed. Allowed: ${this.policy.allowedFormats.join(', ')}`
      );
    }

    // Check holder binding
    if (this.policy.requireHolderBinding && !result.holderBindingVerified) {
      errors.push('Holder binding verification is required but not verified');
    }

    // Check issuer trust
    if (this.policy.requireIssuerTrust && !result.issuerTrusted) {
      errors.push('Issuer trust verification is required but issuer is not trusted');
    }

    // Check status
    if (this.policy.requireStatusCheck && !result.statusValid) {
      errors.push('Status check is required but credential status is not valid');
    }

    // Check credential age
    if (result.issuedAt && !this.isWithinMaxAge(result.issuedAt)) {
      warnings.push(`Credential is older than max age of ${this.policy.maxCredentialAge} seconds`);
    }

    // ==========================================================================
    // Optional HAIP checks (for strict compliance)
    // ==========================================================================

    // Check request object requirement
    if (this.policy.requireRequestObject && result.usedRequestObject === false) {
      errors.push('Request object (JAR) is required but was not used');
    }

    // Check KB-JWT nonce requirement
    if (this.policy.requireNonceInKBJWT && result.kbJwtHasNonce === false) {
      errors.push('Nonce in KB-JWT is required but was not present');
    }

    // Check KB-JWT audience requirement
    if (this.policy.requireAudienceInKBJWT && result.kbJwtHasAudience === false) {
      errors.push('Audience in KB-JWT is required but was not present');
    }

    // Check client ID scheme
    if (this.policy.allowedClientIdSchemes && result.clientIdScheme) {
      if (!this.policy.allowedClientIdSchemes.includes(result.clientIdScheme)) {
        errors.push(
          `Client ID scheme '${result.clientIdScheme}' is not allowed. Allowed: ${this.policy.allowedClientIdSchemes.join(', ')}`
        );
      }
    }

    // Check cnf JKT requirement
    if (this.policy.requireJktInCnf && result.cnfUsesJkt === false) {
      warnings.push('Confirmation claim should use JWK thumbprint (jkt) for HAIP compliance');
    }

    // Check type header requirement
    if (this.policy.requireTypHeader && result.hasCorrectTypHeader === false) {
      errors.push("Type header 'dc+sd-jwt' is required in issuer JWT");
    }

    // Check trust chain requirement
    if (this.policy.requireTrustChain && result.trustChainVerified === false) {
      errors.push('Trust chain verification is required but failed');
    }

    // Check clock skew for expiration
    if (result.expiresAt && this.policy.maxClockSkew) {
      const now = Math.floor(Date.now() / 1000);
      const skewAllowed = this.policy.maxClockSkew;

      if (result.expiresAt + skewAllowed < now) {
        errors.push('Credential has expired (considering clock skew allowance)');
      }
    }

    return {
      valid: errors.length === 0,
      haipCompliant: errors.length === 0 && warnings.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Check if a client ID scheme is allowed
   */
  isClientIdSchemeAllowed(scheme: HaipClientIdScheme): boolean {
    if (!this.policy.allowedClientIdSchemes) {
      return true; // No restriction
    }
    return this.policy.allowedClientIdSchemes.includes(scheme);
  }

  /**
   * Check if credential is expired considering clock skew
   */
  isExpired(expiresAt: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    const skew = this.policy.maxClockSkew || 0;
    return expiresAt + skew < now;
  }
}

/**
 * Input for HAIP verification validation
 */
export interface HaipVerificationInput {
  /** Signature algorithm used */
  algorithm: string;

  /** Credential format */
  format: string;

  /** Was holder binding verified */
  holderBindingVerified: boolean;

  /** Is issuer in trusted registry */
  issuerTrusted: boolean;

  /** Is credential status valid (not revoked) */
  statusValid: boolean;

  /** Credential issuance timestamp (Unix seconds) */
  issuedAt?: number;

  // ==========================================================================
  // Optional HAIP verification inputs (for 100% compliance)
  // ==========================================================================

  /** Was a request object (JAR) used */
  usedRequestObject?: boolean;

  /** Was nonce present in KB-JWT */
  kbJwtHasNonce?: boolean;

  /** Was audience present in KB-JWT */
  kbJwtHasAudience?: boolean;

  /** Client ID scheme used */
  clientIdScheme?: HaipClientIdScheme;

  /** Does cnf claim use JWK thumbprint (jkt) */
  cnfUsesJkt?: boolean;

  /** Does issuer JWT have correct type header (dc+sd-jwt) */
  hasCorrectTypHeader?: boolean;

  /** Was trust chain verified */
  trustChainVerified?: boolean;

  /** Credential expiration timestamp (Unix seconds) */
  expiresAt?: number;
}

/**
 * HAIP validation result
 */
export interface HaipValidationResult {
  /** Is the verification valid (meets minimum requirements) */
  valid: boolean;

  /** Is the verification fully HAIP compliant */
  haipCompliant: boolean;

  /** List of validation errors */
  errors: string[];

  /** List of validation warnings */
  warnings: string[];
}
