/**
 * Keys Module Tests
 */

import { describe, it, expect } from 'vitest';
import {
  generateKeyId,
  generateRsaKeyPair,
  generateHexSecret,
  generateBase64Secret,
  generateAllSecrets,
  validatePrivateKey,
  validatePublicKeyJwk,
} from '../core/keys.js';

describe('generateKeyId', () => {
  it('should generate a key ID with default prefix', () => {
    const keyId = generateKeyId();

    expect(keyId).toMatch(/^dev-key-\d+-[a-zA-Z0-9_-]+$/);
  });

  it('should generate a key ID with custom prefix', () => {
    const keyId = generateKeyId('prod');

    expect(keyId).toMatch(/^prod-key-\d+-[a-zA-Z0-9_-]+$/);
  });

  it('should generate unique key IDs', () => {
    const keyId1 = generateKeyId('test');
    const keyId2 = generateKeyId('test');

    expect(keyId1).not.toBe(keyId2);
  });
});

describe('generateRsaKeyPair', () => {
  it('should generate a valid RSA key pair', () => {
    const keyPair = generateRsaKeyPair('test-key');

    expect(keyPair.keyId).toBe('test-key');
    expect(keyPair.privateKeyPem).toContain('-----BEGIN PRIVATE KEY-----');
    expect(keyPair.publicKeyJwk.kty).toBe('RSA');
    expect(keyPair.publicKeyJwk.kid).toBe('test-key');
    expect(keyPair.publicKeyJwk.use).toBe('sig');
    expect(keyPair.publicKeyJwk.alg).toBe('RS256');
    expect(keyPair.createdAt).toBeDefined();
  });

  it('should generate key with auto-generated ID', () => {
    const keyPair = generateRsaKeyPair();

    expect(keyPair.keyId).toMatch(/^dev-key-\d+-[a-zA-Z0-9_-]+$/);
  });
});

describe('generateHexSecret', () => {
  it('should generate 32-byte hex secret by default', () => {
    const secret = generateHexSecret();

    expect(secret).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should generate custom size hex secret', () => {
    const secret = generateHexSecret(16);

    expect(secret).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe('generateBase64Secret', () => {
  it('should generate base64url secret', () => {
    const secret = generateBase64Secret();

    expect(secret).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(secret.length).toBeGreaterThan(0);
  });
});

describe('generateAllSecrets', () => {
  it('should generate all required secrets', () => {
    const secrets = generateAllSecrets('test-key');

    expect(secrets.keyPair).toBeDefined();
    expect(secrets.keyPair.keyId).toBe('test-key');
    expect(secrets.rpTokenEncryptionKey).toMatch(/^[a-f0-9]{64}$/);
    expect(secrets.adminApiSecret).toBeDefined();
    expect(secrets.keyManagerSecret).toBeDefined();
    expect(secrets.setupToken).toBeDefined();
  });
});

describe('validatePrivateKey', () => {
  it('should validate a valid RSA private key', () => {
    const keyPair = generateRsaKeyPair();

    expect(validatePrivateKey(keyPair.privateKeyPem)).toBe(true);
  });

  it('should reject invalid private key', () => {
    expect(validatePrivateKey('invalid-key')).toBe(false);
  });
});

describe('validatePublicKeyJwk', () => {
  it('should validate a valid JWK', () => {
    const keyPair = generateRsaKeyPair('test-key');

    expect(validatePublicKeyJwk(keyPair.publicKeyJwk)).toBe(true);
  });

  it('should reject JWK without required fields', () => {
    expect(validatePublicKeyJwk({ kty: 'RSA' })).toBe(false);
    expect(validatePublicKeyJwk({ kty: 'RSA', n: 'xxx', e: 'xxx' })).toBe(false);
  });

  it('should reject non-RSA JWK', () => {
    expect(validatePublicKeyJwk({ kty: 'EC', kid: 'test' })).toBe(false);
  });
});
