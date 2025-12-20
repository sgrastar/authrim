/**
 * VP Token Verifier Service
 *
 * Verifies VP tokens (SD-JWT VCs with Key Binding JWTs).
 * Implements HAIP-compliant verification.
 */

import {
  parseSDJWTVC,
  verifySDJWTVC,
  HaipPolicyEvaluator,
  getHaipPolicy,
  checkCredentialStatus,
  D1Adapter,
  TrustedIssuerRepository,
  decodeBase64Url,
} from '@authrim/shared';
import type { StatusListKeyResolver } from '@authrim/shared';
import type { Env, VPVerificationResult } from '../../types';
import { checkIssuerTrust, getIssuerPublicKey } from './issuer-trust';
import { createVCConfigManager } from '../../utils/vc-config';

export interface VPVerifyOptions {
  /** Nonce from the authorization request */
  nonce: string;

  /** Expected audience (verifier identifier) */
  audience: string;

  /** Tenant ID */
  tenantId: string;
}

/**
 * Verify a VP token (SD-JWT VC with optional KB-JWT)
 */
export async function verifyVPToken(
  env: Env,
  vpToken: string,
  options: VPVerifyOptions
): Promise<VPVerificationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // 1. Parse the SD-JWT VC
    const parsed = await parseSDJWTVC(vpToken);

    if (!parsed) {
      return {
        verified: false,
        holderBindingVerified: false,
        issuerTrusted: false,
        statusValid: false,
        errors: ['Invalid SD-JWT VC format'],
        warnings: [],
        haipCompliant: false,
      };
    }

    const { payload, kbJwt } = parsed;
    const issuerDid = payload.iss;
    const vct = payload.vct;

    // 2. Get HAIP policy from config (KV > env > default)
    const configManager = createVCConfigManager(env);
    const haipVersion = await configManager.getHaipPolicyVersion();
    const policy = getHaipPolicy(haipVersion);
    const evaluator = new HaipPolicyEvaluator(policy);

    // 3. Check issuer trust using repository
    const adapter = new D1Adapter({ db: env.DB });
    const trustedIssuerRepo = new TrustedIssuerRepository(adapter);
    const trustResult = await checkIssuerTrust(trustedIssuerRepo, issuerDid, options.tenantId);
    const issuerTrusted = trustResult.trusted;

    if (!issuerTrusted && policy.requireIssuerTrust) {
      errors.push(`Issuer not trusted: ${issuerDid}`);
    }

    // 4. Get issuer public key
    let issuerPublicKey: CryptoKey | null = null;
    try {
      issuerPublicKey = await getIssuerPublicKey(env, issuerDid, trustResult.jwksUri);
    } catch (e) {
      errors.push(`Failed to get issuer public key: ${e instanceof Error ? e.message : 'Unknown'}`);
    }

    // 5. Verify SD-JWT VC signature
    let signatureValid = false;
    let disclosedClaims: Record<string, unknown> = {};
    let holderBindingVerified = false;

    if (issuerPublicKey) {
      try {
        const verifyResult = await verifySDJWTVC(vpToken, issuerPublicKey, null, {
          issuer: issuerDid,
          vct,
          nonce: options.nonce,
          audience: options.audience,
        });

        signatureValid = verifyResult.verified;
        disclosedClaims = verifyResult.disclosedClaims;
        holderBindingVerified = verifyResult.holderBindingVerified;
      } catch (e) {
        errors.push(`Signature verification failed: ${e instanceof Error ? e.message : 'Unknown'}`);
      }
    }

    // 6. Check credential status (supports both W3C credentialStatus and IETF status formats)
    // SECURITY: Status List JWT signature is verified to prevent MITM attacks
    let statusValid = true;
    const statusInfo = extractStatusInfo(payload);

    if (statusInfo) {
      try {
        // Create a key resolver that uses the issuer's JWKS or trusted issuer config
        // SECURITY: Status List issuer MUST match credential issuer to prevent cache poisoning
        const statusKeyResolver: StatusListKeyResolver = async (statusIssuer, _kid) => {
          // CRITICAL: Reject status lists from different issuers
          // This prevents attackers from hosting their own status list that always returns "valid"
          if (statusIssuer !== issuerDid) {
            throw new Error(
              `Status List issuer mismatch: credential issued by ${issuerDid} but status list issued by ${statusIssuer}`
            );
          }
          // Use the credential issuer's public key
          if (issuerPublicKey) {
            return issuerPublicKey;
          }
          // Fallback: fetch from JWKS (same issuer, so this is safe)
          return getIssuerPublicKey(env, statusIssuer, trustResult.jwksUri);
        };

        statusValid = await checkCredentialStatus(statusInfo.uri, statusInfo.index, {
          cacheTtlMs: 5 * 60 * 1000, // 5 minute cache
          verifySignature: true, // SECURITY: Always verify Status List JWT signature
          keyResolver: statusKeyResolver,
        });
        if (!statusValid) {
          errors.push(
            `Credential has been ${statusInfo.purpose === 'suspension' ? 'suspended' : 'revoked'}`
          );
        }
      } catch (e) {
        const errorMessage = `Status check failed: ${e instanceof Error ? e.message : 'Unknown'}`;
        // HAIP: Status check failure is fatal when requireStatusCheck is true
        if (policy.requireStatusCheck) {
          errors.push(errorMessage);
          statusValid = false;
        } else {
          warnings.push(errorMessage);
          // Non-HAIP: allow continuation on network errors
          statusValid = true;
        }
      }
    } else if (policy.requireStatusCheck) {
      // HAIP requires status claim to be present
      errors.push('Status claim required but not present in credential');
      statusValid = false;
    }

    // 7. Check holder binding
    if (policy.requireHolderBinding && !holderBindingVerified) {
      if (kbJwt) {
        errors.push('Key Binding JWT verification failed');
      } else {
        errors.push('Key Binding JWT required but not present');
      }
    }

    // 8. Extract algorithm from JWT header
    const algorithm = extractAlgorithmFromVPToken(vpToken);

    // 9. Validate against HAIP policy
    const haipResult = evaluator.validateVerificationResult({
      algorithm,
      format: 'dc+sd-jwt',
      holderBindingVerified,
      issuerTrusted,
      statusValid,
    });

    if (!haipResult.valid) {
      errors.push(...haipResult.errors);
    }
    warnings.push(...haipResult.warnings);

    // 10. Build result
    const verified = signatureValid && errors.length === 0;

    return {
      verified,
      issuerDid,
      credentialType: vct,
      format: 'dc+sd-jwt',
      disclosedClaims,
      holderBindingVerified,
      issuerTrusted,
      statusValid,
      errors,
      warnings,
      haipCompliant: haipResult.haipCompliant,
    };
  } catch (error) {
    return {
      verified: false,
      holderBindingVerified: false,
      issuerTrusted: false,
      statusValid: false,
      errors: [`Verification error: ${error instanceof Error ? error.message : 'Unknown'}`],
      warnings,
      haipCompliant: false,
    };
  }
}

/**
 * Extract the signing algorithm from a VP token (SD-JWT VC)
 */
function extractAlgorithmFromVPToken(vpToken: string): string {
  try {
    // SD-JWT VC format: header.payload.signature~disclosure1~...~kb-jwt
    const parts = vpToken.split('~');
    const issuerJwt = parts[0];
    const jwtParts = issuerJwt.split('.');

    if (jwtParts.length < 2) {
      return 'ES256'; // Default fallback
    }

    // Decode header (base64url) - use shared utility for proper padding handling
    const headerStr = decodeBase64Url(jwtParts[0]);
    const header = JSON.parse(headerStr) as { alg?: string };

    return header.alg || 'ES256';
  } catch {
    return 'ES256'; // Default fallback on parse error
  }
}

/**
 * Status info extracted from credential payload
 */
interface StatusInfo {
  uri: string;
  index: number;
  purpose: 'revocation' | 'suspension';
}

/**
 * Extract status information from credential payload
 *
 * Supports multiple status claim formats:
 * 1. W3C VC Data Model 2.0 - credentialStatus (BitstringStatusListEntry)
 * 2. IETF Status List - status.status_list
 */
function extractStatusInfo(payload: Record<string, unknown>): StatusInfo | null {
  // Format 1: W3C VC credentialStatus (BitstringStatusListEntry)
  // Used by our credential issuance
  const credentialStatus = payload.credentialStatus as
    | {
        type?: string;
        statusPurpose?: string;
        statusListIndex?: number;
        statusListCredential?: string;
      }
    | undefined;

  if (
    credentialStatus?.type === 'BitstringStatusListEntry' &&
    credentialStatus.statusListCredential &&
    typeof credentialStatus.statusListIndex === 'number'
  ) {
    return {
      uri: credentialStatus.statusListCredential,
      index: credentialStatus.statusListIndex,
      purpose: credentialStatus.statusPurpose === 'suspension' ? 'suspension' : 'revocation',
    };
  }

  // Format 2: IETF Status List (SD-JWT VC profile)
  const status = payload.status as
    | {
        status_list?: {
          uri?: string;
          idx?: number;
        };
      }
    | undefined;

  if (status?.status_list?.uri && typeof status.status_list.idx === 'number') {
    return {
      uri: status.status_list.uri,
      index: status.status_list.idx,
      purpose: 'revocation', // IETF format doesn't specify purpose in the same way
    };
  }

  return null;
}
