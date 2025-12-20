/**
 * Crypto Utilities Tests
 *
 * Tests for cryptographic utility functions.
 */

import { describe, it, expect } from 'vitest';
import { generateSecureNonce, generateRandomString, sha256Base64url } from '../crypto';

describe('generateSecureNonce', () => {
  it('should generate a hex string of correct length', async () => {
    const nonce = await generateSecureNonce(32);

    // 32 bytes = 64 hex characters
    expect(nonce).toHaveLength(64);
    expect(nonce).toMatch(/^[0-9a-f]+$/);
  });

  it('should generate different nonces each time', async () => {
    const nonce1 = await generateSecureNonce();
    const nonce2 = await generateSecureNonce();

    expect(nonce1).not.toBe(nonce2);
  });

  it('should default to 32 bytes (64 hex chars)', async () => {
    const nonce = await generateSecureNonce();

    expect(nonce).toHaveLength(64);
  });

  it('should handle custom lengths', async () => {
    const nonce16 = await generateSecureNonce(16);
    const nonce64 = await generateSecureNonce(64);

    expect(nonce16).toHaveLength(32); // 16 bytes = 32 hex
    expect(nonce64).toHaveLength(128); // 64 bytes = 128 hex
  });
});

describe('generateRandomString', () => {
  it('should generate a URL-safe base64 string', async () => {
    const randomStr = generateRandomString(32);

    // URL-safe base64 should not contain + / or =
    expect(randomStr).not.toMatch(/[+/=]/);
    // Should only contain alphanumeric, -, _
    expect(randomStr).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('should generate different strings each time', async () => {
    const str1 = generateRandomString();
    const str2 = generateRandomString();

    expect(str1).not.toBe(str2);
  });

  it('should generate strings of appropriate length', async () => {
    const str = generateRandomString(32);

    // 32 bytes = ~43 base64 chars (without padding)
    expect(str.length).toBeGreaterThan(30);
    expect(str.length).toBeLessThan(50);
  });
});

describe('sha256Base64url', () => {
  it('should compute SHA-256 hash in base64url format', async () => {
    const hash = await sha256Base64url('test');

    // Known SHA-256 hash of "test" in base64url
    // SHA-256("test") = 0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
    expect(hash).toBe('n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg');
  });

  it('should return URL-safe base64', async () => {
    const hash = await sha256Base64url('test data with + and /');

    // Should not contain + / or =
    expect(hash).not.toMatch(/[+/=]/);
  });

  it('should produce consistent output for same input', async () => {
    const hash1 = await sha256Base64url('consistent input');
    const hash2 = await sha256Base64url('consistent input');

    expect(hash1).toBe(hash2);
  });

  it('should produce different output for different input', async () => {
    const hash1 = await sha256Base64url('input1');
    const hash2 = await sha256Base64url('input2');

    expect(hash1).not.toBe(hash2);
  });

  it('should handle empty string', async () => {
    const hash = await sha256Base64url('');

    // SHA-256 of empty string is well-defined
    expect(hash).toBeTruthy();
    expect(hash.length).toBeGreaterThan(0);
  });

  it('should handle unicode strings', async () => {
    const hash = await sha256Base64url('こんにちは世界');

    expect(hash).toBeTruthy();
    expect(hash).not.toMatch(/[+/=]/);
  });
});
