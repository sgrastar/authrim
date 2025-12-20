/**
 * Issuer Trust Service
 *
 * Manages trusted VC issuers and their public keys.
 */

import type { Env } from '../../types';
import { importECPublicKey, safeFetch, resolveDID } from '@authrim/shared';
import type { TrustedIssuerRepository, TrustedIssuerRecord } from '@authrim/shared';
import type { JWK } from 'jose';
import { importJWK } from 'jose';

export interface IssuerTrustResult {
  trusted: boolean;
  issuer?: {
    id: string;
    tenantId: string;
    issuerDid: string;
    displayName?: string;
    credentialTypes: string[];
    trustLevel: 'standard' | 'high';
    jwksUri?: string;
    status: 'active' | 'suspended' | 'revoked';
    createdAt: number;
    updatedAt: number;
  };
  jwksUri?: string;
  reason?: string;
}

/**
 * Convert repository TrustedIssuerRecord to domain model
 */
function toIssuerModel(
  issuer: TrustedIssuerRecord,
  parseCredentialTypes: (i: TrustedIssuerRecord) => string[]
): IssuerTrustResult['issuer'] {
  return {
    id: issuer.id,
    tenantId: issuer.tenant_id,
    issuerDid: issuer.issuer_did,
    displayName: issuer.display_name || undefined,
    credentialTypes: parseCredentialTypes(issuer),
    trustLevel: issuer.trust_level,
    jwksUri: issuer.jwks_uri || undefined,
    status: issuer.status,
    createdAt: issuer.created_at,
    updatedAt: issuer.updated_at,
  };
}

/**
 * Check if an issuer is trusted for a tenant
 */
export async function checkIssuerTrust(
  trustedIssuerRepo: TrustedIssuerRepository,
  issuerDid: string,
  tenantId: string
): Promise<IssuerTrustResult> {
  try {
    // Query trusted issuers using repository
    const result = await trustedIssuerRepo.findActiveTrustedIssuer(tenantId, issuerDid);

    if (!result) {
      return {
        trusted: false,
        reason: 'Issuer not found in trusted issuers registry',
      };
    }

    const issuer = toIssuerModel(result, (i) => trustedIssuerRepo.parseCredentialTypes(i));

    return {
      trusted: true,
      issuer,
      jwksUri: issuer?.jwksUri,
    };
  } catch (error) {
    console.error('[checkIssuerTrust] Error:', error);
    return {
      trusted: false,
      reason: `Database error: ${error instanceof Error ? error.message : 'Unknown'}`,
    };
  }
}

/**
 * Get issuer's public key for signature verification
 */
export async function getIssuerPublicKey(
  env: Env,
  issuerDid: string,
  jwksUri?: string
): Promise<CryptoKey> {
  // Try JWKS URI first if provided
  if (jwksUri) {
    return getKeyFromJwksUri(jwksUri);
  }

  // Fall back to DID document resolution
  return getKeyFromDid(env, issuerDid);
}

/**
 * Fetch public key from JWKS URI
 */
async function getKeyFromJwksUri(jwksUri: string): Promise<CryptoKey> {
  // Use safeFetch for SSRF protection, timeout, and response size limits
  const response = await safeFetch(jwksUri, {
    headers: { Accept: 'application/json' },
    requireHttps: true,
    timeoutMs: 10000,
    maxResponseSize: 256 * 1024, // 256 KB max for JWKS
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS: ${response.status}`);
  }

  const text = await response.text();
  const jwks = JSON.parse(text) as { keys: JWK[] };

  // Find a signing key (ES256, ES384, or ES512)
  const signingKey = jwks.keys.find(
    (key) =>
      key.use === 'sig' && key.kty === 'EC' && ['ES256', 'ES384', 'ES512'].includes(key.alg || '')
  );

  if (!signingKey) {
    throw new Error('No suitable EC signing key found in JWKS');
  }

  return importECPublicKey(signingKey);
}

/**
 * Resolve DID and extract public key
 *
 * Uses the shared resolveDID function which fully supports:
 * - did:web (with SSRF protection via safeFetch)
 * - did:key (with multibase/multicodec decoding to JWK)
 */
async function getKeyFromDid(env: Env, did: string): Promise<CryptoKey> {
  // Resolve DID document using shared resolver
  const didDocument = await resolveDID(did);

  if (!didDocument) {
    throw new Error(`Failed to resolve DID: ${did}`);
  }

  // Find verification method with public key
  const verificationMethods = didDocument.verificationMethod;

  if (!verificationMethods || verificationMethods.length === 0) {
    throw new Error('No verification methods found in DID document');
  }

  // Try to find an EC key first (for HAIP compliance)
  let verificationMethod = verificationMethods.find(
    (vm) =>
      vm.publicKeyJwk?.kty === 'EC' &&
      ['P-256', 'P-384', 'P-521'].includes(vm.publicKeyJwk?.crv || '')
  );

  // Fall back to OKP (Ed25519) if no EC key found
  if (!verificationMethod) {
    verificationMethod = verificationMethods.find(
      (vm) => vm.publicKeyJwk?.kty === 'OKP' && vm.publicKeyJwk?.crv === 'Ed25519'
    );
  }

  // Last resort: any key with publicKeyJwk
  if (!verificationMethod) {
    verificationMethod = verificationMethods.find((vm) => vm.publicKeyJwk);
  }

  if (!verificationMethod?.publicKeyJwk) {
    throw new Error('No public key found in DID document');
  }

  const jwk = verificationMethod.publicKeyJwk;

  // Import based on key type
  if (jwk.kty === 'EC') {
    return importECPublicKey(jwk as JWK);
  } else if (jwk.kty === 'OKP') {
    // Use jose's importJWK for OKP keys
    return (await importJWK(jwk as JWK, jwk.alg || 'EdDSA')) as CryptoKey;
  } else {
    throw new Error(`Unsupported key type: ${jwk.kty}`);
  }
}

/**
 * Self-issuance guard
 * Prevents accepting VCs issued by the same Authrim instance
 */
export async function checkSelfIssuance(
  env: Env,
  issuerDid: string,
  _tenantId: string
): Promise<boolean> {
  const authrimDid = env.VERIFIER_IDENTIFIER || 'did:web:authrim.com';

  if (issuerDid === authrimDid) {
    console.warn('[checkSelfIssuance] Rejected self-issued credential');
    return false; // Self-issued - reject
  }

  return true; // Not self-issued - OK
}
