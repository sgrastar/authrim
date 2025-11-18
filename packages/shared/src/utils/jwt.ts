/**
 * JWT Token Utilities
 *
 * Provides functions for creating and verifying JWT tokens (ID tokens and access tokens).
 * Uses the JOSE library for standards-compliant JWT operations.
 */

import { SignJWT, jwtVerify, importPKCS8, importJWK } from 'jose';
import type { JWK, CryptoKey, JWTPayload } from 'jose';
import { generateSecureRandomString } from './crypto';
import type { IDTokenClaims } from '../types/oidc';

/**
 * Access Token claims interface
 */
export interface AccessTokenClaims extends JWTPayload {
  iss: string; // Issuer
  sub: string; // Subject (user identifier)
  aud: string; // Audience (client_id or resource server)
  exp: number; // Expiration time
  iat: number; // Issued at time
  jti: string; // JWT ID (unique token identifier for revocation)
  scope: string; // Granted scopes
  client_id: string; // Client identifier
  claims?: string; // Requested claims (JSON string, per OIDC Core 5.5)
  cnf?: { jkt: string }; // DPoP confirmation (RFC 9449 Section 6)
}

/**
 * Create ID Token (signed JWT)
 *
 * @param claims - ID token claims
 * @param privateKey - Private key for signing
 * @param kid - Key ID
 * @param expiresIn - Token expiration time in seconds (default: 3600)
 * @returns Promise<string> - Signed JWT
 */
export async function createIDToken(
  claims: Omit<IDTokenClaims, 'iat' | 'exp'>,
  privateKey: CryptoKey,
  kid: string,
  expiresIn: number = 3600
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  return await new SignJWT({
    ...claims,
    iat: now,
    exp: now + expiresIn,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
    .sign(privateKey);
}

/**
 * Create Access Token (signed JWT)
 *
 * @param claims - Access token claims
 * @param privateKey - Private key for signing
 * @param kid - Key ID
 * @param expiresIn - Token expiration time in seconds (default: 3600)
 * @returns Promise<{ token: string; jti: string }> - Signed JWT and its unique identifier
 */
export async function createAccessToken(
  claims: Omit<AccessTokenClaims, 'iat' | 'exp' | 'jti'>,
  privateKey: CryptoKey,
  kid: string,
  expiresIn: number = 3600
): Promise<{ token: string; jti: string }> {
  const now = Math.floor(Date.now() / 1000);
  // Generate unique token identifier with enhanced security (~128 characters)
  const jti = generateSecureRandomString(96);

  const token = await new SignJWT({
    ...claims,
    iat: now,
    exp: now + expiresIn,
    jti,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
    .sign(privateKey);

  return { token, jti };
}

/**
 * Verify JWT token signature and claims
 *
 * @param token - JWT token to verify
 * @param publicKey - Public key for verification
 * @param issuer - Expected issuer
 * @param audience - Expected audience
 * @returns Promise<JWTPayload> - Decoded and verified claims
 */
export async function verifyToken(
  token: string,
  publicKey: CryptoKey,
  issuer: string,
  audience: string
): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, publicKey, {
    issuer,
    audience,
    algorithms: ['RS256'],
  });

  return payload;
}

/**
 * Parse JWT token without verification (use with caution!)
 *
 * WARNING: This function does NOT verify the token signature.
 * Only use for extracting claims from already verified tokens.
 *
 * @param token - JWT token to parse
 * @returns Decoded payload (unverified)
 */
export function parseToken(token: string): JWTPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const payload = parts[1];
  if (!payload) {
    throw new Error('Invalid JWT payload');
  }

  // Convert base64url to base64 (Workers-compatible)
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');

  // Decode using atob (available in Workers runtime)
  const decoded = atob(base64);

  return JSON.parse(decoded) as JWTPayload;
}

/**
 * Import private key from PEM format (PKCS#8)
 *
 * @param pem - PEM-formatted private key
 * @returns Promise<CryptoKey>
 */
export async function importPrivateKeyFromPEM(pem: string): Promise<CryptoKey> {
  return await importPKCS8(pem, 'RS256');
}

/**
 * Import public key from JWK format
 *
 * @param jwk - JWK public key
 * @returns Promise<CryptoKey>
 */
export async function importPublicKeyFromJWK(jwk: JWK): Promise<CryptoKey> {
  return (await importJWK(jwk, 'RS256')) as CryptoKey;
}

/**
 * Calculate at_hash (Access Token Hash) for ID Token
 * https://openid.net/specs/openid-connect-core-1_0.html#CodeIDToken
 *
 * The at_hash is the base64url encoding of the left-most half of the hash
 * of the octets of the ASCII representation of the access_token value.
 *
 * @param accessToken - Access token to hash
 * @param algorithm - Hash algorithm (default: SHA-256 for RS256)
 * @returns Promise<string> - base64url encoded hash
 */
export async function calculateAtHash(
  accessToken: string,
  algorithm: 'SHA-256' | 'SHA-384' | 'SHA-512' = 'SHA-256'
): Promise<string> {
  // Convert access token to bytes
  const encoder = new TextEncoder();
  const data = encoder.encode(accessToken);

  // Hash the access token
  const hashBuffer = await crypto.subtle.digest(algorithm, data);

  // Take the left-most half of the hash
  const halfLength = hashBuffer.byteLength / 2;
  const leftHalf = hashBuffer.slice(0, halfLength);

  // Convert to base64url
  const hashArray = Array.from(new Uint8Array(leftHalf));
  const base64 = btoa(String.fromCharCode(...hashArray));
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  return base64url;
}

/**
 * Calculate c_hash (Code Hash) for ID Token
 * Used in implicit and hybrid flows
 *
 * @param code - Authorization code to hash
 * @param algorithm - Hash algorithm (default: SHA-256 for RS256)
 * @returns Promise<string> - base64url encoded hash
 */
export async function calculateCHash(
  code: string,
  algorithm: 'SHA-256' | 'SHA-384' | 'SHA-512' = 'SHA-256'
): Promise<string> {
  // Same calculation as at_hash
  return calculateAtHash(code, algorithm);
}

/**
 * Refresh Token claims interface
 */
export interface RefreshTokenClaims extends JWTPayload {
  iss: string; // Issuer
  sub: string; // Subject (user identifier)
  aud: string; // Audience (client_id)
  exp: number; // Expiration time
  iat: number; // Issued at time
  jti: string; // JWT ID (unique token identifier)
  scope: string; // Granted scopes
  client_id: string; // Client identifier
}

/**
 * Create Refresh Token (signed JWT)
 * https://tools.ietf.org/html/rfc6749#section-6
 *
 * @param claims - Refresh token claims
 * @param privateKey - Private key for signing
 * @param kid - Key ID
 * @param expiresIn - Token expiration time in seconds (default: 2592000 = 30 days)
 * @returns Promise<{ token: string; jti: string }> - Signed JWT and its unique identifier
 */
export async function createRefreshToken(
  claims: Omit<RefreshTokenClaims, 'iat' | 'exp' | 'jti'>,
  privateKey: CryptoKey,
  kid: string,
  expiresIn: number = 2592000
): Promise<{ token: string; jti: string }> {
  const now = Math.floor(Date.now() / 1000);
  // Generate unique token identifier with enhanced security (~128 characters)
  const jti = generateSecureRandomString(96);

  const token = await new SignJWT({
    ...claims,
    iat: now,
    exp: now + expiresIn,
    jti,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
    .sign(privateKey);

  return { token, jti };
}
