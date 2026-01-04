/**
 * Apple Sign In JWT Utilities
 *
 * Apple Sign In requires a dynamically generated client_secret for token exchange.
 * The client_secret is a JWT signed with the app's private key (ES256).
 *
 * JWT Structure:
 * - Header: { alg: "ES256", kid: "<Key ID>" }
 * - Payload:
 *   - iss: Team ID
 *   - sub: Client ID (Service ID or Bundle ID)
 *   - aud: "https://appleid.apple.com"
 *   - iat: Current timestamp
 *   - exp: Expiration (max 6 months)
 *
 * References:
 * - https://developer.apple.com/documentation/sign_in_with_apple/generate_and_validate_tokens
 * - https://developer.apple.com/documentation/sign_in_with_apple/configuring_your_environment_for_sign_in_with_apple
 */

import * as jose from 'jose';
import { createLogger } from '@authrim/ar-lib-core';

const log = createLogger().module('EXTERNAL-IDP');

/**
 * Maximum validity period for Apple client_secret JWT (6 months in seconds)
 */
export const APPLE_MAX_CLIENT_SECRET_TTL = 15552000; // 180 days

/**
 * Default validity period for Apple client_secret JWT (30 days in seconds)
 */
export const APPLE_DEFAULT_CLIENT_SECRET_TTL = 2592000; // 30 days

/**
 * Generate Apple Sign In client_secret JWT
 *
 * @param teamId - Apple Developer Team ID (10 characters)
 * @param clientId - Service ID (e.g., "com.example.app") or Bundle ID
 * @param keyId - Sign in with Apple Key ID (10 characters)
 * @param privateKeyPem - P-256 private key in PEM format (from .p8 file)
 * @param ttlSeconds - JWT validity period in seconds (max 6 months, default 30 days)
 * @returns JWT string to use as client_secret
 *
 * @example
 * ```typescript
 * const clientSecret = await generateAppleClientSecret(
 *   'ABCDE12345',        // Team ID
 *   'com.example.app',   // Service ID
 *   'ZYXWV98765',        // Key ID
 *   '-----BEGIN PRIVATE KEY-----\n...',
 *   2592000              // 30 days
 * );
 * ```
 */
export async function generateAppleClientSecret(
  teamId: string,
  clientId: string,
  keyId: string,
  privateKeyPem: string,
  ttlSeconds: number = APPLE_DEFAULT_CLIENT_SECRET_TTL
): Promise<string> {
  // Validate inputs
  if (!teamId || teamId.length !== 10) {
    throw new Error('Apple Team ID must be exactly 10 characters');
  }

  if (!clientId) {
    throw new Error('Apple Client ID (Service ID) is required');
  }

  if (!keyId || keyId.length !== 10) {
    throw new Error('Apple Key ID must be exactly 10 characters');
  }

  if (!privateKeyPem || !privateKeyPem.includes('PRIVATE KEY')) {
    throw new Error('Invalid private key PEM format');
  }

  // Enforce maximum TTL
  const effectiveTtl = Math.min(ttlSeconds, APPLE_MAX_CLIENT_SECRET_TTL);

  // Import the P-256 private key
  const privateKey = await jose.importPKCS8(privateKeyPem, 'ES256');

  const now = Math.floor(Date.now() / 1000);

  // Build and sign the JWT
  const jwt = await new jose.SignJWT({})
    .setProtectedHeader({
      alg: 'ES256',
      kid: keyId,
    })
    .setIssuer(teamId)
    .setSubject(clientId)
    .setAudience('https://appleid.apple.com')
    .setIssuedAt(now)
    .setExpirationTime(now + effectiveTtl)
    .sign(privateKey);

  return jwt;
}

/**
 * Validate Apple private key format
 *
 * @param privateKeyPem - PEM-encoded private key
 * @returns true if the key appears to be a valid P-256 key
 */
export function validateApplePrivateKey(privateKeyPem: string): boolean {
  if (!privateKeyPem) {
    return false;
  }

  // Check for PEM markers
  if (!privateKeyPem.includes('-----BEGIN PRIVATE KEY-----')) {
    return false;
  }

  if (!privateKeyPem.includes('-----END PRIVATE KEY-----')) {
    return false;
  }

  // Basic length check (P-256 keys are typically ~200-250 bytes base64)
  const base64Content = privateKeyPem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');

  // P-256 private keys in PKCS#8 format are around 120-180 base64 characters
  if (base64Content.length < 100 || base64Content.length > 300) {
    return false;
  }

  return true;
}

/**
 * Parse Apple user object from callback
 *
 * Apple returns user information in a JSON object on the first authorization.
 * This data is only sent once and must be captured during the callback.
 *
 * @param userJson - JSON string from 'user' query parameter
 * @returns Parsed user object or null if invalid
 *
 * @example
 * User object structure:
 * {
 *   "name": {
 *     "firstName": "John",
 *     "lastName": "Doe"
 *   },
 *   "email": "user@example.com"
 * }
 */
export function parseAppleUserData(userJson: string | undefined | null): {
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
} | null {
  if (!userJson) {
    return null;
  }

  try {
    const userData = JSON.parse(userJson);

    const result: {
      name?: string;
      given_name?: string;
      family_name?: string;
      email?: string;
    } = {};

    // Extract name components
    if (userData.name) {
      const firstName = userData.name.firstName || '';
      const lastName = userData.name.lastName || '';

      if (firstName) {
        result.given_name = firstName;
      }

      if (lastName) {
        result.family_name = lastName;
      }

      const fullName = `${firstName} ${lastName}`.trim();
      if (fullName) {
        result.name = fullName;
      }
    }

    // Extract email (only provided on first auth if scope includes 'email')
    if (userData.email) {
      result.email = userData.email;
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch {
    log.warn('Failed to parse Apple user data');
    return null;
  }
}
