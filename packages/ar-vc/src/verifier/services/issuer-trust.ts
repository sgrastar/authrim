/**
 * Issuer Trust Service
 *
 * Manages trusted VC issuers and their public keys.
 */

import type { Env } from '../../types';
import {
  importECPublicKey,
  safeFetchJson,
  resolveDID,
  createLogger,
  buildIssuerUrl,
} from '@authrim/ar-lib-core';
import type { TrustedIssuerRepository, TrustedIssuerRecord } from '@authrim/ar-lib-core';
import type { JWK } from 'jose';
import { importJWK } from 'jose';

const log = createLogger().module('VC-ISSUER-TRUST');

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
    log.error('Issuer trust verification failed', {}, error as Error);
    // SECURITY: Do not expose internal error details in response
    return {
      trusted: false,
      reason: 'Failed to verify issuer trust',
    };
  }
}

/**
 * Get issuer's public key for signature verification.
 *
 * With a `kid` (from the signed JWT's header) the key is the one it names, never another key of
 * the issuer: after a rotation an issuer publishes several keys. Without one, the issuer's single
 * suitable key is used as before.
 */
export async function getIssuerPublicKey(
  env: Env,
  issuerDid: string,
  jwksUri?: string,
  kid?: string
): Promise<CryptoKey> {
  // Try JWKS URI first if provided
  if (jwksUri) {
    return getKeyFromJwksUri(jwksUri, kid);
  }

  // An https issuer publishes its keys in SD-JWT VC Issuer Metadata
  if (issuerDid.startsWith('https://')) {
    return getKeyFromIssuerMetadata(issuerDid, kid);
  }

  // Fall back to DID document resolution
  return getKeyFromDid(env, issuerDid, kid);
}

/**
 * The SD-JWT VC Issuer Metadata URL of an https issuer: `/.well-known/jwt-vc-issuer` inserted
 * between the host and the path (draft-ietf-oauth-sd-jwt-vc, section 5).
 */
export function jwtVcIssuerMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) {
    throw new Error('Issuer must be an https URL without query, fragment or credentials');
  }
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return `${url.origin}/.well-known/jwt-vc-issuer${path}`;
}

/**
 * Resolve the key from the issuer's own metadata. The metadata must name exactly this issuer, and
 * holds the keys inline (`jwks`) or at an https `jwks_uri`.
 */
async function getKeyFromIssuerMetadata(issuer: string, kid?: string): Promise<CryptoKey> {
  const metadata = await safeFetchJson<{ issuer?: unknown; jwks?: unknown; jwks_uri?: unknown }>(
    jwtVcIssuerMetadataUrl(issuer),
    {
      headers: { Accept: 'application/json' },
      requireHttps: true,
      timeoutMs: 10000,
      maxResponseSize: 256 * 1024,
    }
  );
  if (metadata.issuer !== issuer) {
    throw new Error('Issuer metadata names a different issuer');
  }
  const inline = metadata.jwks as { keys?: unknown } | undefined;
  if (inline !== undefined) {
    if (!Array.isArray(inline?.keys)) throw new Error('Issuer metadata jwks has no keys');
    return selectJwksSigningKey(inline.keys as JWK[], kid, { optionalUseAndAlg: true });
  }
  if (typeof metadata.jwks_uri === 'string') {
    return getKeyFromJwksUri(metadata.jwks_uri, kid, { optionalUseAndAlg: true });
  }
  throw new Error('Issuer metadata has neither jwks nor jwks_uri');
}

const EC_SIGNING_ALGORITHMS = ['ES256', 'ES384', 'ES512'];
const EC_CURVE_ALGORITHMS: Record<string, string> = {
  'P-256': 'ES256',
  'P-384': 'ES384',
  'P-521': 'ES512',
};

/**
 * Whether a JWK may verify an issuer's signature: an EC key whose `alg` (when stated) is its
 * curve's, or an Ed25519 key, and never one whose stated `use` or `key_ops` rule verifying out.
 */
function isIssuerSigningJwk(
  jwk: { kty?: string; crv?: string; alg?: string; use?: string; key_ops?: string[] } | undefined
): boolean {
  if (!jwk) return false;
  if (jwk.use !== undefined && jwk.use !== 'sig') return false;
  if (jwk.key_ops !== undefined && !jwk.key_ops.includes('verify')) return false;
  if (jwk.kty === 'EC') {
    const alg = EC_CURVE_ALGORITHMS[jwk.crv ?? ''];
    return alg !== undefined && (jwk.alg === undefined || jwk.alg === alg);
  }
  return (
    jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && (jwk.alg === undefined || jwk.alg === 'EdDSA')
  );
}

/**
 * Fetch public key from JWKS URI
 */
async function getKeyFromJwksUri(
  jwksUri: string,
  kid?: string,
  selection: KeySelection = {}
): Promise<CryptoKey> {
  const jwks = await safeFetchJson<{ keys: JWK[] }>(jwksUri, {
    headers: { Accept: 'application/json' },
    requireHttps: true,
    timeoutMs: 10000,
    maxResponseSize: 256 * 1024, // 256 KB max for JWKS
  });

  return selectJwksSigningKey(jwks.keys, kid, selection);
}

interface KeySelection {
  /**
   * Without a kid, accept the one key that passes the signing-key rules even when it omits the
   * optional `use` and `alg` (SD-JWT VC Issuer Metadata). Otherwise a kid-less signature needs a
   * key stating `use: sig` and its `alg`.
   */
  optionalUseAndAlg?: boolean;
}

/** The one EC signing key of a JWKS that a signature may be verified with. */
function selectJwksSigningKey(
  keys: JWK[],
  kid?: string,
  selection: KeySelection = {}
): Promise<CryptoKey> {
  // The same signing-key rules with or without a kid; without one the JWKS must hold exactly one
  // (ES256, ES384 or ES512 with use "sig") rather than the first in document order.
  const signingKeys = keys.filter((key) => key.kty === 'EC' && isIssuerSigningJwk(key));
  const candidates =
    kid !== undefined
      ? signingKeys.filter((key) => key.kid === kid)
      : selection.optionalUseAndAlg
        ? signingKeys
        : signingKeys.filter(
            (key) => key.use === 'sig' && EC_SIGNING_ALGORITHMS.includes(key.alg || '')
          );
  if (candidates.length > 1) {
    throw new Error('JWKS has several matching signing keys: the signature must name one with kid');
  }
  const signingKey = candidates[0];

  if (!signingKey) {
    throw new Error('No suitable EC signing key found in JWKS');
  }

  return importECPublicKey(withEcAlgorithm(signingKey));
}

/** A DID URL for a method or key reference: absolute, a `#fragment`, or a bare fragment. */
function absoluteMethodId(did: string, reference: string): string {
  if (reference.startsWith('did:')) return reference;
  return `${did}${reference.startsWith('#') ? '' : '#'}${reference}`;
}

/**
 * The one verification method a JWT `kid` names. Method IDs (relative ones resolved against the
 * DID) decide first; a JWK's own `kid` only when no method ID matches. More than one match is
 * ambiguous and refused rather than resolved by document order.
 */
function methodNamedBy<T extends { id: string; publicKeyJwk?: { kid?: string } }>(
  did: string,
  kid: string,
  methods: readonly T[]
): T {
  const target = absoluteMethodId(did, kid);
  const byId = methods.filter((vm) => absoluteMethodId(did, vm.id) === target);
  const matches = byId.length ? byId : methods.filter((vm) => vm.publicKeyJwk?.kid === kid);
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? 'Key id names more than one verification method'
        : 'No verification method matches the key id'
    );
  }
  return matches[0];
}

/** The ES algorithm of an EC public key, taken from its curve when the JWK omits `alg`. */
function withEcAlgorithm(jwk: JWK): JWK {
  if (jwk.alg) return jwk;
  const alg = EC_CURVE_ALGORITHMS[jwk.crv ?? ''];
  return alg ? { ...jwk, alg } : jwk;
}

type DidDocument = NonNullable<Awaited<ReturnType<typeof resolveDID>>>;
type DidVerificationMethod = NonNullable<DidDocument['verificationMethod']>[number];

/**
 * The methods a DID document lets sign assertions (credentials, status lists): its
 * `assertionMethod` entries, references resolved against `verificationMethod`.
 */
function assertionMethodsOf(did: string, document: DidDocument): DidVerificationMethod[] {
  const methods = document.verificationMethod ?? [];
  return (document.assertionMethod ?? []).flatMap((entry) => {
    if (typeof entry !== 'string') return [entry as DidVerificationMethod];
    const id = absoluteMethodId(did, entry);
    return methods.filter((vm) => absoluteMethodId(did, vm.id) === id);
  });
}

/**
 * Resolve DID and extract public key
 *
 * Uses the shared resolveDID function which fully supports:
 * - did:web (with SSRF protection via safeFetch)
 * - did:key (with multibase/multicodec decoding to JWK)
 */
async function getKeyFromDid(env: Env, did: string, kid?: string): Promise<CryptoKey> {
  // Resolve DID document using shared resolver
  const didDocument = await resolveDID(did);

  if (!didDocument) {
    // SECURITY: Do not expose DID value in error message
    throw new Error('Failed to resolve DID document');
  }

  // Only the issuer's own assertion keys sign credentials and status lists, with or without a kid:
  // a key for another purpose, of another controller or of another type never does.
  const isIssuerAssertionKey = (vm: DidVerificationMethod) =>
    vm.controller === did && isIssuerSigningJwk(vm.publicKeyJwk);
  const assertionMethods = assertionMethodsOf(did, didDocument);

  let verificationMethod: DidVerificationMethod;
  if (kid !== undefined) {
    // A kid names exactly one assertion method; a missing one is an error, not a reason to try
    // others.
    verificationMethod = methodNamedBy(did, kid, assertionMethods);
    if (verificationMethod.controller !== did) {
      throw new Error('Verification method is controlled by another DID');
    }
    if (!isIssuerSigningJwk(verificationMethod.publicKeyJwk)) {
      throw new Error('Verification method is not a supported signing key');
    }
  } else {
    // Without a kid the issuer must have exactly one usable assertion key.
    const candidates = assertionMethods.filter(isIssuerAssertionKey);
    if (candidates.length !== 1) {
      throw new Error(
        candidates.length
          ? 'DID document has several assertion keys: the signature must name one with kid'
          : 'No assertion key found in DID document'
      );
    }
    verificationMethod = candidates[0];
  }

  if (!verificationMethod.publicKeyJwk) {
    throw new Error('No public key found in DID document');
  }

  const jwk = verificationMethod.publicKeyJwk;

  // Import based on key type
  if (jwk.kty === 'EC') {
    return importECPublicKey(withEcAlgorithm(jwk as JWK));
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
  tenantId: string
): Promise<boolean> {
  const normalizedTenantId = tenantId.trim();
  if (!normalizedTenantId) {
    log.warn('Rejected issuer trust check without tenant context', {});
    return false;
  }

  const configuredIdentifier = env.VERIFIER_IDENTIFIER;
  let authrimDid = configuredIdentifier || 'did:web:authrim.com';

  if (
    !configuredIdentifier ||
    configuredIdentifier.startsWith('did:web:') ||
    configuredIdentifier.startsWith('https://') ||
    configuredIdentifier.startsWith('http://')
  ) {
    try {
      const issuerUrl = buildIssuerUrl(
        env as unknown as Parameters<typeof buildIssuerUrl>[0],
        normalizedTenantId
      );
      authrimDid = `did:web:${new URL(issuerUrl).hostname}`;
    } catch {
      authrimDid = configuredIdentifier || 'did:web:authrim.com';
    }
  }

  if (issuerDid === authrimDid) {
    log.warn('Rejected self-issued credential', {});
    return false; // Self-issued - reject
  }

  return true; // Not self-issued - OK
}
