/**
 * Attribute Mapper Service
 *
 * Maps disclosed claims from VCs to normalized user attributes.
 * Implements data minimization by storing only normalized boolean/enum values.
 *
 * Design Philosophy:
 * - VC = Attribute Proof (NOT login method)
 * - Raw VC claims are discarded after verification
 * - Only normalized, policy-ready attributes are stored
 */

import type { VPVerificationResult, VPRequestState } from '../../types';
import type {
  UserVerifiedAttributeRepository,
  AttributeVerificationRepository,
} from '@authrim/ar-lib-core';
import { createLogger } from '@authrim/ar-lib-core';

const log = createLogger().module('VC-ATTR-MAPPER');

/**
 * Mapping from VC claims to normalized attribute names
 */
const CLAIM_MAPPINGS: Record<string, string> = {
  // Identity claims
  given_name: 'verified_given_name',
  family_name: 'verified_family_name',
  birthdate: 'verified_birthdate',
  email: 'verified_email',

  // Age verification
  age_over_18: 'verified_age_over_18',
  age_over_21: 'verified_age_over_21',
  age_over_65: 'verified_age_over_65',

  // Address claims
  'address.country': 'verified_country',
  'address.region': 'verified_region',
  'address.locality': 'verified_locality',
  country: 'verified_country',

  // Organization claims
  org_name: 'verified_org_name',
  org_id: 'verified_org_id',

  // Qualification claims
  qualification_type: 'verified_qualification_type',
  license_number: 'verified_license_number',
};

/**
 * Claims that should be stored as boolean
 */
const BOOLEAN_CLAIMS = new Set([
  'age_over_18',
  'age_over_21',
  'age_over_65',
  'email_verified',
  'phone_number_verified',
]);

/**
 * Normalized attribute with its metadata
 */
export interface NormalizedAttribute {
  /** Attribute name in normalized form */
  name: string;
  /** Attribute value (string or boolean converted to string) */
  value: string;
  /** Original claim name from VC */
  originalClaim: string;
}

/**
 * Result of attribute mapping and storage
 */
export interface AttributeMappingResult {
  /** Whether the mapping was successful */
  success: boolean;
  /** IDs of stored attributes */
  attributeIds: string[];
  /** Mapped attributes */
  attributes: NormalizedAttribute[];
  /** Any errors during mapping */
  errors: string[];
}

/**
 * Extract and normalize claims from VP verification result
 */
export function extractNormalizedAttributes(
  disclosedClaims: Record<string, unknown>
): NormalizedAttribute[] {
  const attributes: NormalizedAttribute[] = [];

  for (const [claimName, claimValue] of Object.entries(disclosedClaims)) {
    // Skip null/undefined values
    if (claimValue === null || claimValue === undefined) {
      continue;
    }

    // Handle nested address claims
    if (claimName === 'address' && typeof claimValue === 'object') {
      const address = claimValue as Record<string, unknown>;
      for (const [addrField, addrValue] of Object.entries(address)) {
        const mappedName = CLAIM_MAPPINGS[`address.${addrField}`];
        if (mappedName && addrValue !== null && addrValue !== undefined) {
          // Only accept primitive string/number/boolean values
          if (
            typeof addrValue !== 'string' &&
            typeof addrValue !== 'number' &&
            typeof addrValue !== 'boolean'
          ) {
            continue;
          }
          const stringValue = typeof addrValue === 'string' ? addrValue : String(addrValue);
          attributes.push({
            name: mappedName,
            value: stringValue,
            originalClaim: `address.${addrField}`,
          });
        }
      }
      continue;
    }

    // Look up mapping for this claim
    const mappedName = CLAIM_MAPPINGS[claimName];
    if (!mappedName) {
      // Skip unmapped claims (data minimization)
      continue;
    }

    // Normalize value
    let normalizedValue: string;
    if (BOOLEAN_CLAIMS.has(claimName)) {
      normalizedValue = claimValue === true || claimValue === 'true' ? 'true' : 'false';
    } else if (typeof claimValue === 'object') {
      // Skip complex objects that aren't address
      continue;
    } else if (typeof claimValue === 'string') {
      normalizedValue = claimValue;
    } else if (typeof claimValue === 'number' || typeof claimValue === 'boolean') {
      normalizedValue = String(claimValue);
    } else {
      // Skip unsupported types
      continue;
    }

    attributes.push({
      name: mappedName,
      value: normalizedValue,
      originalClaim: claimName,
    });
  }

  return attributes;
}

/**
 * Store verified attributes for a user
 *
 * This is called after successful VP verification to persist
 * normalized attributes that can be used in ABAC policies.
 *
 * @param attributeRepo UserVerifiedAttribute repository
 * @param userId User ID to associate attributes with
 * @param tenantId Tenant ID
 * @param verificationResult VP verification result
 * @param verificationId ID of the attribute_verifications record
 */
export async function storeUserVerifiedAttributes(
  attributeRepo: UserVerifiedAttributeRepository,
  userId: string,
  tenantId: string,
  verificationResult: VPVerificationResult,
  verificationId: string
): Promise<AttributeMappingResult> {
  const errors: string[] = [];
  const attributeIds: string[] = [];

  // Extract normalized attributes
  const attributes = extractNormalizedAttributes(verificationResult.disclosedClaims || {});

  if (attributes.length === 0) {
    return {
      success: true,
      attributeIds: [],
      attributes: [],
      errors: [],
    };
  }

  const issuerDid = verificationResult.issuerDid || '';

  // Calculate expiry (default: 90 days)
  const defaultExpiry = Date.now() + 90 * 24 * 60 * 60 * 1000;

  // Use repository for upsert operations
  for (const attr of attributes) {
    try {
      const result = await attributeRepo.upsertAttribute({
        tenant_id: tenantId,
        user_id: userId,
        attribute_name: attr.name,
        attribute_value: attr.value,
        source_type: 'vc',
        issuer_did: issuerDid,
        verification_id: verificationId,
        expires_at: defaultExpiry,
      });

      attributeIds.push(result.id);
    } catch (error) {
      log.error('Failed to store verified attribute', { attributeName: attr.name }, error as Error);
      // SECURITY: Do not expose internal error details in response
      errors.push(`Failed to store attribute ${attr.name}`);
    }
  }

  return {
    success: errors.length === 0,
    attributeIds,
    attributes,
    errors,
  };
}

/**
 * Get verified attributes for a user
 */
export async function getUserVerifiedAttributes(
  attributeRepo: UserVerifiedAttributeRepository,
  userId: string,
  tenantId: string
): Promise<Record<string, string>> {
  return attributeRepo.getValidAttributesForUser(tenantId, userId);
}

/**
 * Check if a user has a specific verified attribute
 */
export async function hasVerifiedAttribute(
  attributeRepo: UserVerifiedAttributeRepository,
  userId: string,
  tenantId: string,
  attributeName: string,
  expectedValue?: string
): Promise<boolean> {
  return attributeRepo.hasAttribute(tenantId, userId, attributeName, expectedValue);
}

/**
 * Delete a verified attribute for a user (for GDPR right to be forgotten)
 */
export async function deleteUserVerifiedAttribute(
  attributeRepo: UserVerifiedAttributeRepository,
  userId: string,
  tenantId: string,
  attributeName: string
): Promise<void> {
  await attributeRepo.deleteAttribute(tenantId, userId, attributeName);
}

/**
 * Delete all verified attributes for a user (for account deletion)
 */
export async function deleteAllUserVerifiedAttributes(
  attributeRepo: UserVerifiedAttributeRepository,
  userId: string,
  tenantId: string
): Promise<void> {
  await attributeRepo.deleteAllForUser(tenantId, userId);
}

/**
 * Link VP verification to a logged-in user and store attributes
 *
 * This is the main integration point called after VP verification
 * for attribute elevation use cases.
 */
export async function linkVerificationToUser(
  verificationRepo: AttributeVerificationRepository,
  attributeRepo: UserVerifiedAttributeRepository,
  vpRequest: VPRequestState,
  verificationResult: VPVerificationResult,
  userId: string
): Promise<AttributeMappingResult> {
  // First, store the attribute verification record
  const verification = await verificationRepo.createVerification({
    tenant_id: vpRequest.tenantId,
    user_id: userId,
    vp_request_id: vpRequest.id,
    issuer_did: verificationResult.issuerDid || '',
    credential_type: verificationResult.credentialType || '',
    format: verificationResult.format || 'dc+sd-jwt',
    verification_result: verificationResult.verified ? 'verified' : 'failed',
    holder_binding_verified: verificationResult.holderBindingVerified || false,
    issuer_trusted: verificationResult.issuerTrusted || false,
    status_valid: verificationResult.statusValid || false,
  });

  // Then store the normalized attributes
  return storeUserVerifiedAttributes(
    attributeRepo,
    userId,
    vpRequest.tenantId,
    verificationResult,
    verification.id
  );
}
