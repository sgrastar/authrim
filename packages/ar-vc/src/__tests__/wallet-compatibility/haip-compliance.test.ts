/**
 * HAIP (High Assurance Interoperability Profile) Compliance Tests
 *
 * Tests the VP verification flow against HAIP requirements.
 * Includes both positive tests (should pass) and negative tests (should fail).
 *
 * HAIP Requirements tested:
 * - Key Binding (KB-JWT) is required
 * - Trusted issuer verification
 * - Credential status check
 * - Allowed algorithms (ES256, ES384, ES512)
 * - Nonce verification
 * - Audience verification
 */

import { describe, it, expect } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { createHAIPCompliantWallet } from '../wallet-simulator/mock-wallet';
import type { PresentationDefinition } from '@authrim/ar-lib-core';

// Mock verifier configuration
const VERIFIER_URL = 'https://verifier.example.com';
const ISSUER_URL = 'https://issuer.example.com';

// Sample presentation definition for age verification (used in wallet flow tests)
const _AGE_VERIFICATION_PD: PresentationDefinition = {
  id: 'age-verification-pd',
  input_descriptors: [
    {
      id: 'age_over_18_credential',
      format: {
        'dc+sd-jwt': {
          sd_jwt_alg_values: ['ES256', 'ES384', 'ES512'],
          kb_jwt_alg_values: ['ES256', 'ES384', 'ES512'],
        },
      },
      constraints: {
        fields: [
          {
            path: ['$.vct'],
            filter: {
              type: 'string',
              const: 'AgeVerificationCredential',
            },
          },
          {
            path: ['$.credentialSubject.age_over_18'],
            filter: {
              type: 'boolean',
              const: true,
            },
          },
        ],
      },
    },
  ],
};

/**
 * Helper: Create a mock SD-JWT VC for testing
 */
async function createMockSDJWTVC(options: {
  alg?: string;
  iss?: string;
  vct?: string;
  claims?: Record<string, unknown>;
  includeKeyBinding?: boolean;
  holderDid?: string;
}): Promise<string> {
  const {
    alg = 'ES256',
    iss = ISSUER_URL,
    vct = 'AgeVerificationCredential',
    claims = { age_over_18: true },
    includeKeyBinding = true,
    holderDid,
  } = options;

  // Generate issuer key
  const keyPair = await generateKeyPair(alg as 'ES256' | 'ES384' | 'ES512');
  const _publicJwk = await exportJWK(keyPair.publicKey); // Kept for potential future verification use

  // Create issuer JWT
  const now = Math.floor(Date.now() / 1000);
  const issuerPayload = {
    iss,
    iat: now,
    exp: now + 3600,
    vct,
    cnf: holderDid ? { kid: `${holderDid}#key-1` } : undefined,
    _sd: ['salt1_age_over_18'],
    ...claims,
  };

  const issuerJwt = await new SignJWT(issuerPayload)
    .setProtectedHeader({ alg, typ: 'vc+sd-jwt', kid: `${iss}#key-1` })
    .sign(keyPair.privateKey);

  // Create disclosure for age_over_18
  const disclosure = btoa(JSON.stringify(['salt1', 'age_over_18', claims.age_over_18]))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/[=]+$/, '');

  if (!includeKeyBinding) {
    // Return without KB-JWT
    return `${issuerJwt}~${disclosure}~`;
  }

  // Create holder key and KB-JWT
  const holderKeyPair = await generateKeyPair('ES256');
  const kbJwt = await new SignJWT({
    nonce: 'test-nonce',
    aud: VERIFIER_URL,
    iat: now,
    sd_hash: 'mock-sd-hash',
  })
    .setProtectedHeader({
      alg: 'ES256',
      typ: 'kb+jwt',
      kid: holderDid ? `${holderDid}#key-1` : undefined,
    })
    .sign(holderKeyPair.privateKey);

  return `${issuerJwt}~${disclosure}~${kbJwt}`;
}

/**
 * Mock VP verification result
 */
interface VPVerificationResult {
  verified: boolean;
  errors: string[];
  disclosedClaims?: Record<string, unknown>;
}

/**
 * Mock VP verifier for testing
 */
async function mockVerifyVP(
  vpToken: string,
  options: {
    expectedNonce?: string;
    expectedAudience?: string;
    requireKeyBinding?: boolean;
    checkStatus?: boolean;
    trustedIssuers?: string[];
    allowedAlgorithms?: string[];
    isRevoked?: boolean;
  } = {}
): Promise<VPVerificationResult> {
  const {
    expectedNonce = 'test-nonce',
    expectedAudience = VERIFIER_URL,
    requireKeyBinding = true,
    checkStatus = true,
    trustedIssuers = [ISSUER_URL],
    allowedAlgorithms = ['ES256', 'ES384', 'ES512'],
    isRevoked = false,
  } = options;

  const errors: string[] = [];

  // Parse SD-JWT VC
  const parts = vpToken.split('~');
  if (parts.length < 2) {
    return { verified: false, errors: ['invalid_format'] };
  }

  const issuerJwt = parts[0];
  const _disclosures = parts.slice(1, -1); // Disclosures parsed but not validated in mock
  const kbJwt = parts[parts.length - 1];

  // Decode issuer JWT header
  const [headerB64] = issuerJwt.split('.');
  const headerJson = atob(headerB64.replace(/-/g, '+').replace(/_/g, '/'));
  const header = JSON.parse(headerJson) as { alg: string; kid?: string };

  // Check algorithm
  if (!allowedAlgorithms.includes(header.alg)) {
    errors.push('unsupported_algorithm');
  }

  // Decode payload
  const [, payloadB64] = issuerJwt.split('.');
  const payloadJson = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
  const payload = JSON.parse(payloadJson) as { iss?: string; exp?: number };

  // Check trusted issuer
  if (!payload.iss || !trustedIssuers.includes(payload.iss)) {
    errors.push('untrusted_issuer');
  }

  // Check expiration
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    errors.push('credential_expired');
  }

  // Check key binding
  if (requireKeyBinding) {
    if (!kbJwt || kbJwt === '') {
      errors.push('missing_key_binding');
    } else {
      try {
        // Decode KB-JWT
        const [_kbHeaderB64, kbPayloadB64] = kbJwt.split('.');
        const kbPayloadJson = atob(kbPayloadB64.replace(/-/g, '+').replace(/_/g, '/'));
        const kbPayload = JSON.parse(kbPayloadJson) as { nonce?: string; aud?: string };

        // Check nonce
        if (kbPayload.nonce !== expectedNonce) {
          errors.push('nonce_mismatch');
        }

        // Check audience
        if (kbPayload.aud !== expectedAudience) {
          errors.push('audience_mismatch');
        }
      } catch {
        errors.push('invalid_key_binding');
      }
    }
  }

  // Check revocation status
  if (checkStatus && isRevoked) {
    errors.push('credential_revoked');
  }

  return {
    verified: errors.length === 0,
    errors,
    disclosedClaims: errors.length === 0 ? { age_over_18: true } : undefined,
  };
}

// =============================================================================
// HAIP Compliance Tests
// =============================================================================

describe('HAIP Compliance', () => {
  // ===========================================================================
  // Positive Tests - Should Pass
  // ===========================================================================
  describe('Positive Cases - Should Pass', () => {
    it('should accept valid VP with KB-JWT from trusted issuer', async () => {
      const wallet = await createHAIPCompliantWallet();
      const holderDid = wallet.getDid();

      const credential = await createMockSDJWTVC({
        holderDid,
        includeKeyBinding: true,
      });

      const result = await mockVerifyVP(credential, {
        expectedNonce: 'test-nonce',
        expectedAudience: VERIFIER_URL,
        trustedIssuers: [ISSUER_URL],
      });

      expect(result.verified).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.disclosedClaims?.age_over_18).toBe(true);
    });

    it('should accept VP with ES384 algorithm', async () => {
      const credential = await createMockSDJWTVC({
        alg: 'ES384',
        includeKeyBinding: true,
      });

      const result = await mockVerifyVP(credential, {
        allowedAlgorithms: ['ES256', 'ES384', 'ES512'],
      });

      expect(result.verified).toBe(true);
    });

    it('should accept VP with ES512 algorithm', async () => {
      const credential = await createMockSDJWTVC({
        alg: 'ES512',
        includeKeyBinding: true,
      });

      const result = await mockVerifyVP(credential, {
        allowedAlgorithms: ['ES256', 'ES384', 'ES512'],
      });

      expect(result.verified).toBe(true);
    });

    it('should accept VP from multiple trusted issuers', async () => {
      const credential = await createMockSDJWTVC({
        iss: 'https://other-issuer.example.com',
        includeKeyBinding: true,
      });

      const result = await mockVerifyVP(credential, {
        trustedIssuers: [ISSUER_URL, 'https://other-issuer.example.com'],
      });

      expect(result.verified).toBe(true);
    });
  });

  // ===========================================================================
  // Negative Tests - Should Fail (HAIP value is in rejection)
  // ===========================================================================
  describe('Negative Cases - MUST Reject', () => {
    it('should REJECT VP without KB-JWT', async () => {
      const credential = await createMockSDJWTVC({
        includeKeyBinding: false,
      });

      const result = await mockVerifyVP(credential, {
        requireKeyBinding: true,
      });

      expect(result.verified).toBe(false);
      expect(result.errors).toContain('missing_key_binding');
    });

    it('should REJECT VP with revoked credential', async () => {
      const credential = await createMockSDJWTVC({
        includeKeyBinding: true,
      });

      const result = await mockVerifyVP(credential, {
        checkStatus: true,
        isRevoked: true,
      });

      expect(result.verified).toBe(false);
      expect(result.errors).toContain('credential_revoked');
    });

    it('should REJECT VP with non-HAIP algorithm (EdDSA)', async () => {
      // Note: EdDSA not in HAIP allowed list, but we test the rejection
      // We simulate this by using ES256 but checking against restricted list
      const credential = await createMockSDJWTVC({
        alg: 'ES256',
        includeKeyBinding: true,
      });

      const result = await mockVerifyVP(credential, {
        allowedAlgorithms: ['ES384', 'ES512'], // Exclude ES256 to simulate EdDSA rejection
      });

      expect(result.verified).toBe(false);
      expect(result.errors).toContain('unsupported_algorithm');
    });

    it('should REJECT VP from untrusted issuer', async () => {
      const credential = await createMockSDJWTVC({
        iss: 'https://untrusted-issuer.example.com',
        includeKeyBinding: true,
      });

      const result = await mockVerifyVP(credential, {
        trustedIssuers: [ISSUER_URL], // Does not include untrusted issuer
      });

      expect(result.verified).toBe(false);
      expect(result.errors).toContain('untrusted_issuer');
    });

    it('should REJECT VP with expired credential', async () => {
      // Create expired credential
      const keyPair = await generateKeyPair('ES256');
      const expiredTime = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

      const issuerJwt = await new SignJWT({
        iss: ISSUER_URL,
        iat: expiredTime - 7200,
        exp: expiredTime, // Expired
        vct: 'AgeVerificationCredential',
        age_over_18: true,
      })
        .setProtectedHeader({ alg: 'ES256', typ: 'vc+sd-jwt' })
        .sign(keyPair.privateKey);

      // Create KB-JWT
      const holderKeyPair = await generateKeyPair('ES256');
      const kbJwt = await new SignJWT({
        nonce: 'test-nonce',
        aud: VERIFIER_URL,
        iat: Math.floor(Date.now() / 1000),
      })
        .setProtectedHeader({ alg: 'ES256', typ: 'kb+jwt' })
        .sign(holderKeyPair.privateKey);

      const credential = `${issuerJwt}~~${kbJwt}`;

      const result = await mockVerifyVP(credential);

      expect(result.verified).toBe(false);
      expect(result.errors).toContain('credential_expired');
    });

    it('should REJECT VP with invalid nonce', async () => {
      const credential = await createMockSDJWTVC({
        includeKeyBinding: true,
      });

      const result = await mockVerifyVP(credential, {
        expectedNonce: 'different-nonce', // Expected nonce doesn't match
      });

      expect(result.verified).toBe(false);
      expect(result.errors).toContain('nonce_mismatch');
    });

    it('should REJECT VP with invalid audience', async () => {
      // Create credential with KB-JWT targeting wrong audience
      const keyPair = await generateKeyPair('ES256');
      const now = Math.floor(Date.now() / 1000);

      const issuerJwt = await new SignJWT({
        iss: ISSUER_URL,
        iat: now,
        exp: now + 3600,
        vct: 'AgeVerificationCredential',
      })
        .setProtectedHeader({ alg: 'ES256', typ: 'vc+sd-jwt' })
        .sign(keyPair.privateKey);

      // KB-JWT with wrong audience
      const holderKeyPair = await generateKeyPair('ES256');
      const kbJwt = await new SignJWT({
        nonce: 'test-nonce',
        aud: 'https://wrong-verifier.example.com', // Wrong audience
        iat: now,
      })
        .setProtectedHeader({ alg: 'ES256', typ: 'kb+jwt' })
        .sign(holderKeyPair.privateKey);

      const credential = `${issuerJwt}~~${kbJwt}`;

      const result = await mockVerifyVP(credential, {
        expectedAudience: VERIFIER_URL,
      });

      expect(result.verified).toBe(false);
      expect(result.errors).toContain('audience_mismatch');
    });

    it('should accumulate multiple errors', async () => {
      // Create credential that violates multiple HAIP requirements
      const credential = await createMockSDJWTVC({
        iss: 'https://untrusted.example.com',
        includeKeyBinding: false,
      });

      const result = await mockVerifyVP(credential, {
        trustedIssuers: [ISSUER_URL],
        requireKeyBinding: true,
        isRevoked: true,
      });

      expect(result.verified).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
      expect(result.errors).toContain('untrusted_issuer');
      expect(result.errors).toContain('missing_key_binding');
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================
  describe('Edge Cases', () => {
    it('should handle empty VP token', async () => {
      const result = await mockVerifyVP('');

      expect(result.verified).toBe(false);
      expect(result.errors).toContain('invalid_format');
    });

    it('should handle malformed SD-JWT', async () => {
      const result = await mockVerifyVP('not-a-valid-jwt');

      expect(result.verified).toBe(false);
    });

    it('should pass when KB-JWT is not required (non-HAIP mode)', async () => {
      const credential = await createMockSDJWTVC({
        includeKeyBinding: false,
      });

      const result = await mockVerifyVP(credential, {
        requireKeyBinding: false, // Disable KB-JWT requirement
      });

      // Should pass since KB-JWT is not required
      expect(result.verified).toBe(true);
    });

    it('should pass when status check is disabled', async () => {
      const credential = await createMockSDJWTVC({
        includeKeyBinding: true,
      });

      const result = await mockVerifyVP(credential, {
        checkStatus: false,
        isRevoked: true, // Credential is revoked but check is disabled
      });

      // Should pass since status check is disabled
      expect(result.verified).toBe(true);
    });
  });
});
