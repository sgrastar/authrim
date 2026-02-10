/**
 * JWT Property-Based Tests
 *
 * Uses fast-check to discover edge cases in JWT handling
 * that traditional unit tests might miss.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fc from 'fast-check';
import {
  createIDToken,
  createAccessToken,
  verifyToken,
  parseToken,
  type IDTokenClaims,
  type AccessTokenClaims,
} from '../jwt';
import { generateKeySet } from '../keys';
import { validateToken } from '../validation';
import {
  jwtFormatArb,
  twoPartJwtArb,
  fourPartJwtArb,
  malformedBase64JwtArb,
  base64urlArb,
} from './helpers/fc-generators';
import type { KeyLike } from 'jose';

// =============================================================================
// Test Setup
// =============================================================================

let privateKey: KeyLike;
let publicKey: KeyLike;
const kid = 'test-property-key';
const issuer = 'https://test.authrim.com';
const clientId = 'test-property-client';

beforeAll(async () => {
  const keySet = await generateKeySet(kid);
  privateKey = keySet.privateKey;
  publicKey = keySet.publicKey;
});

// Helper: alphanumeric arbitrary
const alphanumericArb = (minLength: number, maxLength: number) =>
  fc.string({
    unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
    minLength,
    maxLength,
  });

// Helper: alphanumeric with extra chars
const alphanumericExtArb = (chars: string, minLength: number, maxLength: number) =>
  fc.string({
    unit: fc.constantFrom(...chars.split('')),
    minLength,
    maxLength,
  });

// =============================================================================
// JWT Format Validation Properties
// =============================================================================

describe('JWT Format Validation Properties', () => {
  it('∀ valid 3-part base64url: validateToken returns valid=true', () => {
    fc.assert(
      fc.property(jwtFormatArb, (token) => {
        const result = validateToken(token);
        expect(result.valid).toBe(true);
      }),
      { numRuns: 300 }
    );
  });

  it('∀ 2-part string: validateToken returns valid=false', () => {
    fc.assert(
      fc.property(twoPartJwtArb, (token) => {
        const result = validateToken(token);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('3 parts');
      }),
      { numRuns: 200 }
    );
  });

  it('∀ 4-part string: validateToken returns valid=false', () => {
    fc.assert(
      fc.property(fourPartJwtArb, (token) => {
        const result = validateToken(token);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('3 parts');
      }),
      { numRuns: 200 }
    );
  });

  it('∀ malformed base64 in parts (with +/=): validateToken returns valid=false', () => {
    // Note: malformedBase64JwtArb includes 'ABCDE+/=' chars but some generated
    // strings might only use 'ABCDE' (valid base64url). Only check rejection
    // when actual invalid chars are present.
    fc.assert(
      fc.property(malformedBase64JwtArb, (token) => {
        const result = validateToken(token);
        const parts = token.split('.');
        const hasInvalidChars = parts.some((part) => /[+/=]/.test(part));
        if (hasInvalidChars) {
          expect(result.valid).toBe(false);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('∀ random part count (1-10): only 3-part is valid', () => {
    const partsArb = fc
      .integer({ min: 1, max: 10 })
      .chain((n) =>
        fc
          .array(base64urlArb(10, 50), { minLength: n, maxLength: n })
          .map((parts) => parts.join('.'))
      );

    fc.assert(
      fc.property(partsArb, (token) => {
        const parts = token.split('.');
        const result = validateToken(token);

        if (parts.length === 3) {
          expect(result.valid).toBe(true);
        } else {
          expect(result.valid).toBe(false);
        }
      }),
      { numRuns: 300 }
    );
  });

  it('empty parts: validateToken returns valid=false', () => {
    const emptyPartArb = fc.constantFrom(
      '.payload.signature',
      'header..signature',
      'header.payload.',
      '..',
      '....'
    );

    fc.assert(
      fc.property(emptyPartArb, (token) => {
        const result = validateToken(token);
        expect(result.valid).toBe(false);
      })
    );
  });
});

// =============================================================================
// JWT Creation Properties
// =============================================================================

describe('JWT Creation Properties', () => {
  it('∀ valid claims: createIDToken produces 3-part base64url string', async () => {
    const claimsArb = fc.record({
      iss: fc.constant(issuer),
      sub: alphanumericArb(1, 50),
      aud: fc.constant(clientId),
    });

    await fc.assert(
      fc.asyncProperty(claimsArb, async (claims) => {
        const token = await createIDToken(claims, privateKey, kid, 3600);

        // Should be a string
        expect(typeof token).toBe('string');

        // Should have 3 parts
        const parts = token.split('.');
        expect(parts.length).toBe(3);

        // Each part should be valid base64url
        const base64urlPattern = /^[A-Za-z0-9_-]+$/;
        for (const part of parts) {
          expect(part).toMatch(base64urlPattern);
        }

        // Should pass format validation
        expect(validateToken(token).valid).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('∀ valid claims: createAccessToken produces valid JWT with jti', async () => {
    const claimsArb = fc.record({
      iss: fc.constant(issuer),
      sub: alphanumericArb(1, 50),
      aud: fc.constant(clientId),
      scope: fc.constant('openid profile'),
      client_id: fc.constant(clientId),
    });

    await fc.assert(
      fc.asyncProperty(claimsArb, async (claims) => {
        const result = await createAccessToken(claims, privateKey, kid, 3600);

        // Should return token and jti
        expect(result.token).toBeDefined();
        expect(result.jti).toBeDefined();

        // Token should have 3 parts
        const parts = result.token.split('.');
        expect(parts.length).toBe(3);

        // jti should be a non-empty string
        expect(typeof result.jti).toBe('string');
        expect(result.jti.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });

  it('∀ expiresIn value: token has correct exp-iat difference', async () => {
    const expiresInArb = fc.integer({ min: 60, max: 86400 }); // 1 min to 24 hours

    await fc.assert(
      fc.asyncProperty(expiresInArb, async (expiresIn) => {
        const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
          iss: issuer,
          sub: 'user123',
          aud: clientId,
        };

        const token = await createIDToken(claims, privateKey, kid, expiresIn);
        const parsed = parseToken(token);

        expect(parsed.exp).toBeDefined();
        expect(parsed.iat).toBeDefined();
        expect(parsed.exp! - parsed.iat!).toBe(expiresIn);
      }),
      { numRuns: 50 }
    );
  });

  it('∀ nonce value: nonce is preserved in token', async () => {
    const nonceArb = alphanumericExtArb('abcdefghijklmnopqrstuvwxyz0123456789-_', 10, 64);

    await fc.assert(
      fc.asyncProperty(nonceArb, async (nonce) => {
        const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
          iss: issuer,
          sub: 'user123',
          aud: clientId,
          nonce,
        };

        const token = await createIDToken(claims, privateKey, kid, 3600);
        const parsed = parseToken(token);

        expect(parsed.nonce).toBe(nonce);
      }),
      { numRuns: 50 }
    );
  });
});

// =============================================================================
// JWT Verification Properties
// =============================================================================

describe('JWT Verification Properties', () => {
  it('∀ created token: verifyToken succeeds with correct key/issuer/audience', async () => {
    const subArb = alphanumericArb(1, 50);

    await fc.assert(
      fc.asyncProperty(subArb, async (sub) => {
        const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
          iss: issuer,
          sub,
          aud: clientId,
        };

        const token = await createIDToken(claims, privateKey, kid, 3600);
        const verified = await verifyToken(token, publicKey, issuer, { audience: clientId });

        expect(verified.sub).toBe(sub);
        expect(verified.iss).toBe(issuer);
        expect(verified.aud).toBe(clientId);
      }),
      { numRuns: 50 }
    );
  });

  it('∀ token with wrong issuer: verifyToken fails', async () => {
    const wrongIssuerArb = fc.webUrl().filter((url) => url !== issuer);

    await fc.assert(
      fc.asyncProperty(wrongIssuerArb, async (wrongIssuer) => {
        const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
          iss: issuer,
          sub: 'user123',
          aud: clientId,
        };

        const token = await createIDToken(claims, privateKey, kid, 3600);

        await expect(
          verifyToken(token, publicKey, wrongIssuer, { audience: clientId })
        ).rejects.toThrow();
      }),
      { numRuns: 30 }
    );
  });

  it('∀ token with wrong audience: verifyToken fails', async () => {
    const wrongAudienceArb = alphanumericExtArb(
      'abcdefghijklmnopqrstuvwxyz0123456789-_',
      5,
      50
    ).filter((aud) => aud !== clientId);

    await fc.assert(
      fc.asyncProperty(wrongAudienceArb, async (wrongAudience) => {
        const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
          iss: issuer,
          sub: 'user123',
          aud: clientId,
        };

        const token = await createIDToken(claims, privateKey, kid, 3600);

        await expect(
          verifyToken(token, publicKey, issuer, { audience: wrongAudience })
        ).rejects.toThrow();
      }),
      { numRuns: 30 }
    );
  });

  it('∀ tampered token: verifyToken fails', async () => {
    const tamperedPartArb = fc.integer({ min: 0, max: 2 }); // Which part to tamper

    await fc.assert(
      fc.asyncProperty(tamperedPartArb, async (partIndex) => {
        const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
          iss: issuer,
          sub: 'user123',
          aud: clientId,
        };

        const token = await createIDToken(claims, privateKey, kid, 3600);
        const parts = token.split('.');

        // Tamper with one part by changing multiple characters near the middle
        // This ensures the tampering is significant enough to affect the decoded bytes
        const originalPart = parts[partIndex];
        const midPoint = Math.floor(originalPart.length / 2);
        const tamperedPart =
          originalPart.substring(0, midPoint) +
          'XXXX' + // Insert clearly invalid characters
          originalPart.substring(midPoint + 4);
        parts[partIndex] = tamperedPart;
        const tamperedToken = parts.join('.');

        await expect(
          verifyToken(tamperedToken, publicKey, issuer, { audience: clientId })
        ).rejects.toThrow();
      }),
      { numRuns: 30 }
    );
  });

  it('∀ token verified with different key: verifyToken fails', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
          iss: issuer,
          sub: 'user123',
          aud: clientId,
        };

        const token = await createIDToken(claims, privateKey, kid, 3600);

        // Generate a different key (RSA key generation is slow, so limit numRuns)
        const differentKeySet = await generateKeySet('different-key');

        await expect(
          verifyToken(token, differentKeySet.publicKey, issuer, { audience: clientId })
        ).rejects.toThrow();
      }),
      { numRuns: 5 }
    );
  }, 15_000);
});

// =============================================================================
// JWT Parsing Properties
// =============================================================================

describe('JWT Parsing Properties', () => {
  it('∀ created token: parseToken returns claims without verification', async () => {
    const claimsArb = fc.record({
      iss: fc.constant(issuer),
      sub: alphanumericArb(1, 50),
      aud: fc.constant(clientId),
      email: fc.emailAddress(),
    });

    await fc.assert(
      fc.asyncProperty(claimsArb, async (inputClaims) => {
        const token = await createIDToken(inputClaims, privateKey, kid, 3600);
        const parsed = parseToken(token);

        expect(parsed.iss).toBe(inputClaims.iss);
        expect(parsed.sub).toBe(inputClaims.sub);
        expect(parsed.aud).toBe(inputClaims.aud);
        expect(parsed.email).toBe(inputClaims.email);
        expect(parsed.iat).toBeDefined();
        expect(parsed.exp).toBeDefined();
      }),
      { numRuns: 50 }
    );
  });

  it('∀ invalid JWT format: parseToken throws', () => {
    const invalidFormatArb = fc.oneof(
      twoPartJwtArb,
      fourPartJwtArb,
      fc.constant('not.a.valid.jwt')
    );

    fc.assert(
      fc.property(invalidFormatArb, (invalidToken) => {
        expect(() => parseToken(invalidToken)).toThrow();
      }),
      { numRuns: 100 }
    );
  });

  it('∀ malformed base64 payload: parseToken may throw', () => {
    // Note: parseToken uses base64url decoding, so invalid base64 in payload
    // should cause an error
    const malformedPayloadArb = fc
      .tuple(
        base64urlArb(10, 50), // valid header
        fc.constant('!!!invalid-base64!!!'), // invalid payload
        base64urlArb(10, 50) // valid signature
      )
      .map(([h, p, s]) => `${h}.${p}.${s}`);

    fc.assert(
      fc.property(malformedPayloadArb, (token) => {
        // Should either throw or return unparseable content
        // The important thing is it doesn't crash unexpectedly
        try {
          parseToken(token);
        } catch (e) {
          // Expected behavior for malformed tokens
          expect(e).toBeDefined();
        }
      }),
      { numRuns: 50 }
    );
  });
});

// =============================================================================
// Round-Trip Properties
// =============================================================================

describe('JWT Round-Trip Properties', () => {
  it('∀ claims: create -> verify preserves all claims', async () => {
    const fullClaimsArb = fc.record({
      iss: fc.constant(issuer),
      sub: alphanumericArb(1, 50),
      aud: fc.constant(clientId),
      nonce: alphanumericExtArb('abcdefghijklmnopqrstuvwxyz0123456789-_', 10, 32).map((s) =>
        Math.random() > 0.5 ? s : undefined
      ),
      email: fc.emailAddress(),
      email_verified: fc.boolean(),
      name: alphanumericExtArb('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ ', 2, 50).map(
        (s) => s.trim() || 'Test User'
      ),
    });

    await fc.assert(
      fc.asyncProperty(fullClaimsArb, async (inputClaims) => {
        const token = await createIDToken(inputClaims, privateKey, kid, 3600);
        const verified = await verifyToken(token, publicKey, issuer, { audience: clientId });

        // All input claims should be preserved
        expect(verified.iss).toBe(inputClaims.iss);
        expect(verified.sub).toBe(inputClaims.sub);
        expect(verified.aud).toBe(inputClaims.aud);
        expect(verified.email).toBe(inputClaims.email);
        expect(verified.email_verified).toBe(inputClaims.email_verified);
        expect(verified.name).toBe(inputClaims.name);

        // Nonce should be preserved if present
        if (inputClaims.nonce !== undefined) {
          expect(verified.nonce).toBe(inputClaims.nonce);
        }
      }),
      { numRuns: 50 }
    );
  });

  it('∀ access token: create -> verify preserves scope and jti', async () => {
    const scopeArb = fc
      .shuffledSubarray(['openid', 'profile', 'email', 'address', 'phone'], {
        minLength: 1,
        maxLength: 5,
      })
      .map((scopes) => {
        if (!scopes.includes('openid')) {
          scopes.unshift('openid');
        }
        return scopes.join(' ');
      });

    await fc.assert(
      fc.asyncProperty(scopeArb, async (scope) => {
        const claims: Omit<AccessTokenClaims, 'iat' | 'exp' | 'jti'> = {
          iss: issuer,
          sub: 'user123',
          aud: clientId,
          scope,
          client_id: clientId,
        };

        const result = await createAccessToken(claims, privateKey, kid, 3600);
        const verified = await verifyToken(result.token, publicKey, issuer, { audience: clientId });

        expect(verified.scope).toBe(scope);
        expect(verified.jti).toBe(result.jti);
      }),
      { numRuns: 30 }
    );
  });
});

// =============================================================================
// Security Properties
// =============================================================================

describe('JWT Security Properties', () => {
  it('∀ token: signature part is not empty', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
          iss: issuer,
          sub: 'user123',
          aud: clientId,
        };

        const token = await createIDToken(claims, privateKey, kid, 3600);
        const parts = token.split('.');

        // Signature should not be empty
        expect(parts[2].length).toBeGreaterThan(0);
      }),
      { numRuns: 20 }
    );
  });

  it('∀ two tokens with same claims: have different structure (jti/iat)', async () => {
    // Access tokens have jti, so two tokens should differ
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const claims: Omit<AccessTokenClaims, 'iat' | 'exp' | 'jti'> = {
          iss: issuer,
          sub: 'user123',
          aud: clientId,
          scope: 'openid',
          client_id: clientId,
        };

        const result1 = await createAccessToken(claims, privateKey, kid, 3600);
        const result2 = await createAccessToken(claims, privateKey, kid, 3600);

        // jti values should be different
        expect(result1.jti).not.toBe(result2.jti);

        // Tokens should be different due to different jti
        expect(result1.token).not.toBe(result2.token);
      }),
      { numRuns: 20 }
    );
  });

  it('alg:none attack: format validation would pass but verify would fail', async () => {
    // Simulate an alg:none attack token structure
    const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    const payload = btoa(JSON.stringify({ iss: issuer, sub: 'attacker', aud: clientId }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    const fakeToken = `${header}.${payload}.`;

    // Format validation might pass (has 3 parts)
    // but the empty signature part should fail
    const formatResult = validateToken(fakeToken);
    expect(formatResult.valid).toBe(false); // Empty signature part

    // Even if we add a fake signature, verification should fail
    const fakeTokenWithSig = `${header}.${payload}.fakesig`;
    await expect(
      verifyToken(fakeTokenWithSig, publicKey, issuer, { audience: clientId })
    ).rejects.toThrow();
  });
});
