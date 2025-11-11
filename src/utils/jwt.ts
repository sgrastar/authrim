/**
 * JWT Token Utilities
 *
 * Provides functions for creating and verifying JWT tokens (ID tokens and access tokens).
 * Uses the JOSE library for standards-compliant JWT operations.
 */

import { SignJWT, jwtVerify, importPKCS8, importJWK } from 'jose';
import type { JWK, KeyLike, JWTPayload } from 'jose';

/**
 * ID Token claims interface
 */
export interface IDTokenClaims extends JWTPayload {
  iss: string; // Issuer
  sub: string; // Subject (user identifier)
  aud: string; // Audience (client_id)
  exp: number; // Expiration time
  iat: number; // Issued at time
  nonce?: string; // Nonce (if provided in auth request)
  email?: string; // Email claim
  email_verified?: boolean; // Email verification status
  name?: string; // Full name
  preferred_username?: string; // Username
}

/**
 * Access Token claims interface
 */
export interface AccessTokenClaims extends JWTPayload {
  iss: string; // Issuer
  sub: string; // Subject (user identifier)
  aud: string; // Audience (client_id or resource server)
  exp: number; // Expiration time
  iat: number; // Issued at time
  scope: string; // Granted scopes
  client_id: string; // Client identifier
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
  privateKey: KeyLike,
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
 * @returns Promise<string> - Signed JWT
 */
export async function createAccessToken(
  claims: Omit<AccessTokenClaims, 'iat' | 'exp'>,
  privateKey: KeyLike,
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
  publicKey: KeyLike,
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
  const decoded = Buffer.from(payload, 'base64url').toString('utf-8');

  return JSON.parse(decoded) as JWTPayload;
}

/**
 * Import private key from PEM format (PKCS#8)
 *
 * @param pem - PEM-formatted private key
 * @returns Promise<KeyLike>
 */
export async function importPrivateKeyFromPEM(pem: string): Promise<KeyLike> {
  return await importPKCS8(pem, 'RS256');
}

/**
 * Import public key from JWK format
 *
 * @param jwk - JWK public key
 * @returns Promise<KeyLike>
 */
export async function importPublicKeyFromJWK(jwk: JWK): Promise<KeyLike> {
  return (await importJWK(jwk, 'RS256')) as KeyLike;
}
