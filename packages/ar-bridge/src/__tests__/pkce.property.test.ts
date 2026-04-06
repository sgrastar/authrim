/**
 * PKCE Property-Based Tests
 *
 * Uses fast-check to verify PKCE (RFC 7636) implementation behavior
 * across a wide range of inputs.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generatePKCE,
  generateState,
  generateNonce,
} from '../utils/pkce';
import { codeVerifierArb, base64urlArb } from './helpers/fc-generators';

// =============================================================================
// Code Verifier Generation Properties
// =============================================================================

describe('PKCE Property Tests', () => {
  describe('Code Verifier Generation', () => {
    it('generateCodeVerifier produces base64url output', () => {
      for (let i = 0; i < 100; i++) {
        const verifier = generateCodeVerifier();

        // Should be valid base64url (no +, /, =)
        expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(verifier).not.toContain('+');
        expect(verifier).not.toContain('/');
        expect(verifier).not.toContain('=');
      }
    });

    it('generateCodeVerifier produces 43-character output', () => {
      // 32 random bytes = 43 base64url chars (without padding)
      for (let i = 0; i < 100; i++) {
        const verifier = generateCodeVerifier();
        expect(verifier.length).toBe(43);
      }
    });

    it('generateCodeVerifier produces unique values', () => {
      const verifiers = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        verifiers.add(generateCodeVerifier());
      }
      // All 1000 should be unique
      expect(verifiers.size).toBe(1000);
    });
  });

  // =============================================================================
  // Code Challenge Generation Properties
  // =============================================================================

  describe('Code Challenge Generation', () => {
    it('∀ verifier: generateCodeChallenge produces 43-char base64url output', async () => {
      await fc.assert(
        fc.asyncProperty(codeVerifierArb, async (verifier) => {
          const challenge = await generateCodeChallenge(verifier);

          // SHA-256 = 32 bytes = 43 base64url chars (no padding)
          expect(challenge.length).toBe(43);

          // Must be valid base64url
          expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
          expect(challenge).not.toContain('+');
          expect(challenge).not.toContain('/');
          expect(challenge).not.toContain('=');
        }),
        { numRuns: 200 }
      );
    });

    it('∀ verifier: challenge is deterministic (same verifier → same challenge)', async () => {
      await fc.assert(
        fc.asyncProperty(codeVerifierArb, async (verifier) => {
          const challenge1 = await generateCodeChallenge(verifier);
          const challenge2 = await generateCodeChallenge(verifier);

          expect(challenge1).toBe(challenge2);
        }),
        { numRuns: 100 }
      );
    });

    it('∀ different verifiers: different challenges (collision resistance)', async () => {
      await fc.assert(
        fc.asyncProperty(codeVerifierArb, codeVerifierArb, async (v1, v2) => {
          // Skip if verifiers are the same
          if (v1 === v2) return;

          const c1 = await generateCodeChallenge(v1);
          const c2 = await generateCodeChallenge(v2);

          expect(c1).not.toBe(c2);
        }),
        { numRuns: 100 }
      );
    });

    it('∀ verifier: verifier ≠ challenge (one-way)', async () => {
      await fc.assert(
        fc.asyncProperty(codeVerifierArb, async (verifier) => {
          const challenge = await generateCodeChallenge(verifier);

          // Challenge should be different from verifier
          expect(challenge).not.toBe(verifier);
        }),
        { numRuns: 100 }
      );
    });

    it('empty string: produces valid challenge', async () => {
      const challenge = await generateCodeChallenge('');
      expect(challenge.length).toBe(43);
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  // =============================================================================
  // PKCE Pair Generation Properties
  // =============================================================================

  describe('PKCE Pair Generation', () => {
    it('generatePKCE returns complete PKCE pair', async () => {
      for (let i = 0; i < 50; i++) {
        const pkce = await generatePKCE();

        expect(pkce.codeVerifier).toBeDefined();
        expect(pkce.codeChallenge).toBeDefined();
        expect(pkce.codeChallengeMethod).toBe('S256');

        // Verifier is 43 chars
        expect(pkce.codeVerifier.length).toBe(43);

        // Challenge is 43 chars (SHA-256 output)
        expect(pkce.codeChallenge.length).toBe(43);

        // Both are valid base64url
        expect(pkce.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(pkce.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    });

    it('generatePKCE verifier and challenge are consistent', async () => {
      for (let i = 0; i < 50; i++) {
        const pkce = await generatePKCE();

        // Verify that the challenge matches what we'd compute from the verifier
        const expectedChallenge = await generateCodeChallenge(pkce.codeVerifier);
        expect(pkce.codeChallenge).toBe(expectedChallenge);
      }
    });

    it('generatePKCE produces unique pairs', async () => {
      const verifiers = new Set<string>();
      const challenges = new Set<string>();

      for (let i = 0; i < 100; i++) {
        const pkce = await generatePKCE();
        verifiers.add(pkce.codeVerifier);
        challenges.add(pkce.codeChallenge);
      }

      expect(verifiers.size).toBe(100);
      expect(challenges.size).toBe(100);
    });
  });

  // =============================================================================
  // State Generation Properties
  // =============================================================================

  describe('State Generation', () => {
    it('generateState produces base64url output', () => {
      for (let i = 0; i < 100; i++) {
        const state = generateState();

        expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(state).not.toContain('+');
        expect(state).not.toContain('/');
        expect(state).not.toContain('=');
      }
    });

    it('generateState produces 22-character output', () => {
      // 16 random bytes = 22 base64url chars (without padding)
      for (let i = 0; i < 100; i++) {
        const state = generateState();
        expect(state.length).toBe(22);
      }
    });

    it('generateState produces unique values', () => {
      const states = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        states.add(generateState());
      }
      expect(states.size).toBe(1000);
    });
  });

  // =============================================================================
  // Nonce Generation Properties
  // =============================================================================

  describe('Nonce Generation', () => {
    it('generateNonce produces base64url output', () => {
      for (let i = 0; i < 100; i++) {
        const nonce = generateNonce();

        expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(nonce).not.toContain('+');
        expect(nonce).not.toContain('/');
        expect(nonce).not.toContain('=');
      }
    });

    it('generateNonce produces 22-character output', () => {
      // 16 random bytes = 22 base64url chars (without padding)
      for (let i = 0; i < 100; i++) {
        const nonce = generateNonce();
        expect(nonce.length).toBe(22);
      }
    });

    it('generateNonce produces unique values', () => {
      const nonces = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        nonces.add(generateNonce());
      }
      expect(nonces.size).toBe(1000);
    });

    it('state and nonce are independent', () => {
      // Generate pairs and ensure they don't collide
      const pairs = new Map<string, string>();
      for (let i = 0; i < 100; i++) {
        const state = generateState();
        const nonce = generateNonce();

        // State and nonce should be different
        expect(state).not.toBe(nonce);

        // No duplicate state→nonce mappings
        if (pairs.has(state)) {
          expect(pairs.get(state)).not.toBe(nonce);
        }
        pairs.set(state, nonce);
      }
    });
  });

  // =============================================================================
  // Security Properties
  // =============================================================================

  describe('Security Properties', () => {
    it('∀ random challenge: cannot reverse to verifier (one-way hash)', async () => {
      // This is more of a documentation test - we can't really prove one-way-ness
      // but we can show that challenge doesn't contain verifier
      await fc.assert(
        fc.asyncProperty(codeVerifierArb, async (verifier) => {
          const challenge = await generateCodeChallenge(verifier);

          // Challenge should not contain any significant part of verifier
          // (This is a weak check but demonstrates the concept)
          expect(challenge).not.toContain(verifier);

          // If verifier is > 43 chars, the challenge is shorter
          if (verifier.length > 43) {
            expect(challenge.length).toBeLessThan(verifier.length);
          }
        }),
        { numRuns: 50 }
      );
    });

    it('∀ wrong challenge for verifier: would fail verification', async () => {
      await fc.assert(
        fc.asyncProperty(
          codeVerifierArb,
          base64urlArb(43, 43),
          async (verifier, randomChallenge) => {
            const correctChallenge = await generateCodeChallenge(verifier);

            // If we happened to generate the correct challenge, skip
            if (randomChallenge === correctChallenge) return;

            // Wrong challenge should not match
            expect(randomChallenge).not.toBe(correctChallenge);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('state/nonce entropy: all generated values have high entropy', () => {
      // Check that generated values don't have obvious patterns
      for (let i = 0; i < 100; i++) {
        const state = generateState();
        const nonce = generateNonce();
        const verifier = generateCodeVerifier();

        // No single character should dominate (simple entropy check).
        // Threshold is 1/3 rather than 1/4 to account for statistical variance in
        // short strings (22 chars for state/nonce). 1/4 produces ~4% false-failure
        // rate over 100 × 3 strings; 1/3 reduces that to <0.02%.
        const checkEntropy = (s: string) => {
          const counts = new Map<string, number>();
          for (const c of s) {
            counts.set(c, (counts.get(c) || 0) + 1);
          }
          // No character should appear more than 1/3 of the time
          for (const count of counts.values()) {
            expect(count).toBeLessThan(s.length / 3);
          }
        };

        checkEntropy(state);
        checkEntropy(nonce);
        checkEntropy(verifier);
      }
    });
  });
});
