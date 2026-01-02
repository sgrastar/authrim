/**
 * JSON Web Key (JWK) Type Definitions
 *
 * Implements RFC 7517: JSON Web Key (JWK)
 * @see https://datatracker.ietf.org/doc/html/rfc7517
 *
 * These types provide type-safe handling of JWK structures used throughout
 * the Authrim OIDC/OAuth2 implementation for:
 * - Client JWKS validation (RFC 9126)
 * - JARM encryption (JWT-Secured Authorization Response Mode)
 * - Request Object signing/encryption (RFC 9101)
 * - DPoP proof validation (RFC 9449)
 */

// =============================================================================
// Algorithm Types
// =============================================================================

/**
 * JWK Signing Algorithms (RFC 7518 Section 3.1)
 * Used for JWT signatures, Request Object signing, etc.
 */
export type JWKSigningAlgorithm =
  | 'RS256'
  | 'RS384'
  | 'RS512'
  | 'ES256'
  | 'ES384'
  | 'ES512'
  | 'PS256'
  | 'PS384'
  | 'PS512';

/**
 * JWK Key Encryption Algorithms (RFC 7518 Section 4.1)
 * Used for JWE key encryption (alg header)
 */
export type JWKKeyEncryptionAlgorithm =
  | 'RSA-OAEP'
  | 'RSA-OAEP-256'
  | 'ECDH-ES'
  | 'ECDH-ES+A128KW'
  | 'ECDH-ES+A192KW'
  | 'ECDH-ES+A256KW'
  | 'A128KW'
  | 'A192KW'
  | 'A256KW'
  | 'A128GCMKW'
  | 'A192GCMKW'
  | 'A256GCMKW';

/**
 * JWK Content Encryption Algorithms (RFC 7518 Section 5.1)
 * Used for JWE content encryption (enc header)
 */
export type JWKContentEncryptionAlgorithm =
  | 'A128CBC-HS256'
  | 'A192CBC-HS384'
  | 'A256CBC-HS512'
  | 'A128GCM'
  | 'A192GCM'
  | 'A256GCM';

// =============================================================================
// Key Properties
// =============================================================================

/**
 * JWK Key Type (RFC 7517 Section 4.1)
 */
export type JWKKeyType = 'RSA' | 'EC' | 'OKP' | 'oct';

/**
 * JWK Public Key Use (RFC 7517 Section 4.2)
 */
export type JWKUse = 'sig' | 'enc';

/**
 * JWK Key Operations (RFC 7517 Section 4.3)
 */
export type JWKKeyOps =
  | 'sign'
  | 'verify'
  | 'encrypt'
  | 'decrypt'
  | 'wrapKey'
  | 'unwrapKey'
  | 'deriveKey'
  | 'deriveBits';

/**
 * Elliptic Curve names for EC keys (RFC 7518 Section 6.2.1.1)
 */
export type ECCurve = 'P-256' | 'P-384' | 'P-521';

// =============================================================================
// JWK Interfaces
// =============================================================================

/**
 * Base JWK properties common to all key types
 */
export interface JWKBase {
  /** Key Type (required) */
  kty: JWKKeyType;
  /** Key ID (optional but recommended) */
  kid?: string;
  /** Public Key Use */
  use?: JWKUse;
  /** Algorithm */
  alg?: string;
  /** Key Operations */
  key_ops?: JWKKeyOps[];
  /** X.509 Certificate Chain */
  x5c?: string[];
  /** X.509 Certificate SHA-1 Thumbprint */
  x5t?: string;
  /** X.509 Certificate SHA-256 Thumbprint */
  'x5t#S256'?: string;
  /** X.509 URL */
  x5u?: string;
}

/**
 * RSA Public Key (RFC 7518 Section 6.3)
 */
export interface RSAPublicJWK extends Omit<JWKBase, 'kty'> {
  kty: 'RSA';
  /** Modulus (Base64url encoded) */
  n: string;
  /** Exponent (Base64url encoded) */
  e: string;
}

/**
 * RSA Private Key (extends public key with private components)
 */
export interface RSAPrivateJWK extends RSAPublicJWK {
  /** Private Exponent */
  d: string;
  /** First Prime Factor */
  p?: string;
  /** Second Prime Factor */
  q?: string;
  /** First Factor CRT Exponent */
  dp?: string;
  /** Second Factor CRT Exponent */
  dq?: string;
  /** First CRT Coefficient */
  qi?: string;
}

/**
 * EC Public Key (RFC 7518 Section 6.2)
 */
export interface ECPublicJWK extends Omit<JWKBase, 'kty'> {
  kty: 'EC';
  /** Curve */
  crv: ECCurve;
  /** X Coordinate (Base64url encoded) */
  x: string;
  /** Y Coordinate (Base64url encoded) */
  y: string;
}

/**
 * EC Private Key (extends public key with private component)
 */
export interface ECPrivateJWK extends ECPublicJWK {
  /** ECC Private Key */
  d: string;
}

/**
 * OKP (Octet Key Pair) Public Key - Ed25519/X25519 (RFC 8037)
 */
export interface OKPPublicJWK extends Omit<JWKBase, 'kty'> {
  kty: 'OKP';
  /** Curve (Ed25519 for signing, X25519 for key agreement) */
  crv: 'Ed25519' | 'Ed448' | 'X25519' | 'X448';
  /** Public Key (Base64url encoded) */
  x: string;
}

/**
 * OKP Private Key
 */
export interface OKPPrivateJWK extends OKPPublicJWK {
  /** Private Key */
  d: string;
}

/**
 * Symmetric Key (RFC 7518 Section 6.4)
 */
export interface SymmetricJWK extends Omit<JWKBase, 'kty'> {
  kty: 'oct';
  /** Key Value (Base64url encoded) */
  k: string;
}

// =============================================================================
// Union Types
// =============================================================================

/**
 * Any public JWK (asymmetric keys only)
 */
export type PublicJWK = RSAPublicJWK | ECPublicJWK | OKPPublicJWK;

/**
 * Any private JWK (asymmetric keys only)
 */
export type PrivateJWK = RSAPrivateJWK | ECPrivateJWK | OKPPrivateJWK;

/**
 * Any JWK (public, private, or symmetric)
 */
export type JWK = PublicJWK | PrivateJWK | SymmetricJWK;

// =============================================================================
// JWK Set
// =============================================================================

/**
 * JWK Set (RFC 7517 Section 5)
 * A JSON object that represents a set of JWKs
 */
export interface JWKS {
  keys: PublicJWK[];
}

/**
 * Extended JWKS with fetch metadata
 * Used for caching client JWKS
 */
export interface JWKSWithMetadata extends JWKS {
  /** When the JWKS was fetched */
  fetchedAt?: number;
  /** When the cached JWKS expires */
  expiresAt?: number;
  /** Source URI of the JWKS */
  sourceUri?: string;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if a JWK is an RSA key
 */
export function isRSAJWK(jwk: JWK): jwk is RSAPublicJWK | RSAPrivateJWK {
  return jwk.kty === 'RSA';
}

/**
 * Check if a JWK is an EC key
 */
export function isECJWK(jwk: JWK): jwk is ECPublicJWK | ECPrivateJWK {
  return jwk.kty === 'EC';
}

/**
 * Check if a JWK is an OKP key
 */
export function isOKPJWK(jwk: JWK): jwk is OKPPublicJWK | OKPPrivateJWK {
  return jwk.kty === 'OKP';
}

/**
 * Check if a JWK is a symmetric key
 */
export function isSymmetricJWK(jwk: JWK): jwk is SymmetricJWK {
  return jwk.kty === 'oct';
}

/**
 * Check if a JWK has a private key component
 */
export function isPrivateJWK(jwk: JWK): jwk is PrivateJWK {
  return 'd' in jwk && jwk.d !== undefined;
}

/**
 * Check if a JWK is for signing (use=sig or key_ops includes sign/verify)
 */
export function isSigningJWK(jwk: JWK): boolean {
  if (jwk.use === 'sig') return true;
  if (jwk.key_ops) {
    return jwk.key_ops.includes('sign') || jwk.key_ops.includes('verify');
  }
  // If neither use nor key_ops is specified, assume it can be used for signing
  return jwk.use === undefined && jwk.key_ops === undefined;
}

/**
 * Check if a JWK is for encryption (use=enc or key_ops includes encrypt/decrypt)
 */
export function isEncryptionJWK(jwk: JWK): boolean {
  if (jwk.use === 'enc') return true;
  if (jwk.key_ops) {
    return (
      jwk.key_ops.includes('encrypt') ||
      jwk.key_ops.includes('decrypt') ||
      jwk.key_ops.includes('wrapKey') ||
      jwk.key_ops.includes('unwrapKey')
    );
  }
  // If neither use nor key_ops is specified, assume it can be used for encryption
  return jwk.use === undefined && jwk.key_ops === undefined;
}
