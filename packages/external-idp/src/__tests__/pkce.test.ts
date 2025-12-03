/**
 * PKCE Utility Tests
 */

import { describe, it, expect } from 'vitest';
import {
  generatePKCE,
  generateState,
  generateNonce,
  generateCodeVerifier,
  generateCodeChallenge,
} from '../utils/pkce';

describe('PKCE Utilities', () => {
  describe('generateCodeVerifier', () => {
    it('should generate a random code verifier', () => {
      const verifier = generateCodeVerifier();

      expect(verifier).toBeDefined();
      expect(typeof verifier).toBe('string');
      expect(verifier.length).toBeGreaterThanOrEqual(32);
    });

    it('should generate unique values each time', () => {
      const verifier1 = generateCodeVerifier();
      const verifier2 = generateCodeVerifier();

      expect(verifier1).not.toBe(verifier2);
    });

    it('should generate URL-safe base64 characters', () => {
      const verifier = generateCodeVerifier();

      // Should not contain +, /, or = (standard base64 characters)
      expect(verifier).not.toMatch(/[+/=]/);

      // Should only contain URL-safe characters
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('generateCodeChallenge', () => {
    it('should generate code challenge from verifier', async () => {
      const verifier = generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);

      expect(challenge).toBeDefined();
      expect(typeof challenge).toBe('string');
      expect(challenge.length).toBeGreaterThan(0);
    });

    it('should produce consistent output for same verifier', async () => {
      const verifier = 'test-verifier-12345';
      const challenge1 = await generateCodeChallenge(verifier);
      const challenge2 = await generateCodeChallenge(verifier);

      expect(challenge1).toBe(challenge2);
    });

    it('should generate URL-safe base64 characters', async () => {
      const verifier = generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);

      // Should not contain +, /, or = (standard base64 characters)
      expect(challenge).not.toMatch(/[+/=]/);

      // Should only contain URL-safe characters
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('generatePKCE', () => {
    it('should generate code verifier and challenge', async () => {
      const pkce = await generatePKCE();

      expect(pkce.codeVerifier).toBeDefined();
      expect(pkce.codeChallenge).toBeDefined();
      expect(pkce.codeChallengeMethod).toBe('S256');
    });

    it('should generate unique values each time', async () => {
      const pkce1 = await generatePKCE();
      const pkce2 = await generatePKCE();

      expect(pkce1.codeVerifier).not.toBe(pkce2.codeVerifier);
      expect(pkce1.codeChallenge).not.toBe(pkce2.codeChallenge);
    });

    it('should produce consistent challenge from verifier', async () => {
      const pkce = await generatePKCE();
      const regeneratedChallenge = await generateCodeChallenge(pkce.codeVerifier);

      expect(pkce.codeChallenge).toBe(regeneratedChallenge);
    });
  });

  describe('generateState', () => {
    it('should generate a random state string', () => {
      const state = generateState();

      expect(state).toBeDefined();
      expect(typeof state).toBe('string');
      expect(state.length).toBeGreaterThan(20);
    });

    it('should generate unique values each time', () => {
      const state1 = generateState();
      const state2 = generateState();

      expect(state1).not.toBe(state2);
    });

    it('should generate URL-safe characters', () => {
      const state = generateState();

      // Should only contain URL-safe characters
      expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('generateNonce', () => {
    it('should generate a random nonce string', () => {
      const nonce = generateNonce();

      expect(nonce).toBeDefined();
      expect(typeof nonce).toBe('string');
      expect(nonce.length).toBeGreaterThan(20);
    });

    it('should generate unique values each time', () => {
      const nonce1 = generateNonce();
      const nonce2 = generateNonce();

      expect(nonce1).not.toBe(nonce2);
    });

    it('should generate URL-safe characters', () => {
      const nonce = generateNonce();

      // Should only contain URL-safe characters
      expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });
});
